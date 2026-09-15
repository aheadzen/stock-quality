// SQLite layer for stock-quality. Single shared connection (better-sqlite3 is
// synchronous and thread-safe for single-process use). Tables live in this
// module's migrations; prepared statements are exported for callers.
//
// evaluation_factors has been denormalized to cache per-question rather than
// per-checklist: each row carries its own (ticker, question_hash,
// evaluated_at). This means editing one question in questions.json only
// invalidates that single factor for every ticker — the rest are reused.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const DB_DIR = path.resolve('./data');
const DB_PATH = path.join(DB_DIR, 'stock-quality.db');

let db = null;
let stmts = null;

function ensureDir() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  ticker TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  profile TEXT,
  price REAL,
  currency TEXT,
  exchange TEXT,
  country TEXT,
  notes TEXT,
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT,
  questions_hash TEXT,
  score INTEGER,
  total INTEGER,
  evaluated_at INTEGER,
  expires_at INTEGER,
  UNIQUE(ticker, questions_hash)
);

CREATE TABLE IF NOT EXISTS evaluation_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id INTEGER,
  ticker TEXT,
  idx INTEGER,
  question TEXT,
  question_hash TEXT,
  score INTEGER,
  reasoning TEXT,
  error TEXT,
  evaluated_at INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input TEXT,
  ticker TEXT,
  status TEXT CHECK(status IN ('pending','processing','done','error','cancelled')),
  score INTEGER,
  total INTEGER,
  error_message TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  completed_at INTEGER,
  user_id INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, ticker),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);
`;

// Idempotent migrations applied on every initDb(). SQLite doesn't have IF NOT
// EXISTS for ADD COLUMN, so we detect via PRAGMA table_info and run only the
// ones still missing.
function migrate(d) {
  // companies.country (ISO 3166-1 alpha-2 code, null for crypto)
  const companyCols = new Set(d.prepare(`PRAGMA table_info(companies)`).all().map((c) => c.name));
  if (!companyCols.has('country')) {
    d.exec(`ALTER TABLE companies ADD COLUMN country TEXT`);
  }

  const cols = new Set(d.prepare(`PRAGMA table_info(evaluation_factors)`).all().map((c) => c.name));
  if (!cols.has('ticker')) {
    d.exec(`ALTER TABLE evaluation_factors ADD COLUMN ticker TEXT`);
  }
  if (!cols.has('question_hash')) {
    d.exec(`ALTER TABLE evaluation_factors ADD COLUMN question_hash TEXT`);
  }
  if (!cols.has('evaluated_at')) {
    d.exec(`ALTER TABLE evaluation_factors ADD COLUMN evaluated_at INTEGER`);
  }

  // Backfill ticker + evaluated_at from the parent evaluations row. question_hash
  // is computed in JS (one UPDATE per row) since SQLite has no built-in sha256.
  // We only touch rows where ticker is still null, so re-running the migration
  // is a no-op.
  const stmt = d.prepare(`
    SELECT f.id, f.question, e.ticker AS ticker, e.evaluated_at AS evaluated_at
    FROM evaluation_factors f
    LEFT JOIN evaluations e ON e.id = f.evaluation_id
    WHERE f.ticker IS NULL OR f.question_hash IS NULL OR f.evaluated_at IS NULL
  `);
  const rows = stmt.all();
  if (rows.length > 0) {
    const updateTicker = d.prepare(
      `UPDATE evaluation_factors SET ticker = ?, evaluated_at = ? WHERE id = ?`
    );
    const updateHash = d.prepare(
      `UPDATE evaluation_factors SET question_hash = ? WHERE id = ?`
    );
    const txn = d.transaction(() => {
      for (const r of rows) {
        if (r.ticker != null) {
          updateTicker.run(r.ticker, r.evaluated_at, r.id);
        }
        updateHash.run(sha256(JSON.stringify(r.question ?? '')), r.id);
      }
    });
    txn();
  }

  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_evaluation_factors_ticker_question_hash
      ON evaluation_factors(ticker, question_hash);
    CREATE INDEX IF NOT EXISTS ix_evaluation_factors_ticker_idx
      ON evaluation_factors(ticker, idx);
  `);

  // requests.user_id (nullable; legacy rows keep NULL → admin sees them in
  // /api/requests but per-user filter excludes them).
  const reqCols = new Set(d.prepare(`PRAGMA table_info(requests)`).all().map((c) => c.name));
  if (!reqCols.has('user_id')) {
    d.exec(`ALTER TABLE requests ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  }
  d.exec(`CREATE INDEX IF NOT EXISTS ix_requests_user_id ON requests(user_id)`);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function initDb() {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  stmts = prepare(db);
  return db;
}

function prepare(d) {
  return {
    upsertCompany: d.prepare(`
      INSERT INTO companies (ticker, name, kind, profile, price, currency, exchange, country, notes, fetched_at)
      VALUES (@ticker, @name, @kind, @profile, @price, @currency, @exchange, @country, @notes, @fetched_at)
      ON CONFLICT(ticker) DO UPDATE SET
        name=excluded.name,
        kind=excluded.kind,
        profile=excluded.profile,
        price=excluded.price,
        currency=excluded.currency,
        exchange=excluded.exchange,
        country=excluded.country,
        notes=excluded.notes,
        fetched_at=excluded.fetched_at
    `),
    findCompany: d.prepare(`SELECT * FROM companies WHERE ticker = ?`),
    findCompanyByName: d.prepare(`SELECT * FROM companies WHERE UPPER(name) = ? LIMIT 1`),

    // Per-factor UPSERT. evaluation_id is left NULL — the table is now self-
    // keyed on (ticker, question_hash) and the column is kept only to avoid a
    // destructive rebuild of legacy rows.
    upsertFactor: d.prepare(`
      INSERT INTO evaluation_factors
        (ticker, idx, question, question_hash, score, reasoning, error, evaluated_at)
      VALUES
        (@ticker, @idx, @question, @question_hash, @score, @reasoning, @error, @evaluated_at)
      ON CONFLICT(ticker, question_hash) DO UPDATE SET
        idx=excluded.idx,
        question=excluded.question,
        score=excluded.score,
        reasoning=excluded.reasoning,
        error=excluded.error,
        evaluated_at=excluded.evaluated_at
    `),
    deleteFactorsForTicker: d.prepare(`DELETE FROM evaluation_factors WHERE ticker = ?`),

    insertRequest: d.prepare(`
      INSERT INTO requests (input, ticker, status, score, total, created_at, updated_at, user_id)
      VALUES (@input, @ticker, @status, @score, @total, @created_at, @updated_at, @user_id)
    `),
    getRequest: d.prepare(`SELECT * FROM requests WHERE id = ?`),
    listOngoing: d.prepare(`
      SELECT * FROM (
        SELECT r.*,
          c.name AS company_name, c.kind AS company_kind, c.profile AS company_profile,
          c.country AS company_country,
          (SELECT MAX(evaluated_at) FROM evaluation_factors WHERE ticker = r.ticker) AS evaluated_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(r.ticker, LOWER(r.input))
            ORDER BY
              CASE r.status
                WHEN 'done' THEN 1
                WHEN 'processing' THEN 2
                WHEN 'pending' THEN 3
                WHEN 'error' THEN 4
              END ASC,
              r.updated_at DESC
          ) AS rn
        FROM requests r
        LEFT JOIN companies c ON c.ticker = r.ticker
      )
      WHERE rn = 1
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    listPending: d.prepare(`
      SELECT * FROM requests
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `),
    listRequestsAll: d.prepare(`
      SELECT * FROM requests
      ORDER BY created_at DESC
      LIMIT ?
    `),
    listRecentErrors: d.prepare(`
      SELECT * FROM requests
      WHERE status = 'error'
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    markRequestProcessing: d.prepare(`
      UPDATE requests SET status='processing', error_message=NULL, updated_at=? WHERE id=? AND status='pending'
    `),
    completeRequest: d.prepare(`
      UPDATE requests
      SET status='done', score=?, total=?, error_message=NULL, updated_at=?, completed_at=?
      WHERE id=?
    `),
    updateRequestProgress: d.prepare(`
      UPDATE requests
      SET score=?, total=?, updated_at=?
      WHERE id=? AND status='processing'
    `),
    failRequestError: d.prepare(`
      UPDATE requests
      SET status='error', error_message=?, score=NULL, total=NULL, updated_at=?, completed_at=?
      WHERE id=?
    `),
    resetProcessingToPending: d.prepare(`
      UPDATE requests SET status='pending', updated_at=? WHERE status='processing'
    `),

    // Best list: per-ticker "complete evaluation" is determined by whether the
    // ticker has at least `?` (count for the matching kind) distinct cached
    // factors. The `?` placeholder is filled by the kind-appropriate count
    // (company or crypto). Tickers with no kind yet (e.g. a request whose
    // company row was deleted) are scored against the company count.
    bestByKindCounts: d.prepare(`
      SELECT r.id, r.input, r.ticker, c.name, c.kind, c.profile, c.country, r.status, r.score, r.total, r.completed_at,
             (SELECT MAX(evaluated_at) FROM evaluation_factors WHERE ticker = r.ticker) AS evaluated_at,
             (SELECT COUNT(DISTINCT question_hash) FROM evaluation_factors WHERE ticker = r.ticker) AS factor_count
      FROM requests r
      LEFT JOIN companies c ON c.ticker = r.ticker
      WHERE r.status = 'done'
        AND r.score IS NOT NULL
        AND (
          CASE WHEN c.kind = 'crypto' THEN
            (SELECT COUNT(DISTINCT question_hash) FROM evaluation_factors WHERE ticker = r.ticker) >= ?
          ELSE
            (SELECT COUNT(DISTINCT question_hash) FROM evaluation_factors WHERE ticker = r.ticker) >= ?
          END
        )
      ORDER BY r.score DESC, r.completed_at DESC
      LIMIT ?
    `),

    // ---- users ----
    insertUser: d.prepare(`
      INSERT INTO users (email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?)
    `),
    findUserByEmail: d.prepare(`SELECT * FROM users WHERE email = ?`),
    findUserById: d.prepare(`SELECT * FROM users WHERE id = ?`),
    listUsers: d.prepare(`
      SELECT id, email, role, created_at FROM users ORDER BY created_at ASC LIMIT ?
    `),
    updateUserPassword: d.prepare(`
      UPDATE users SET password_hash = ? WHERE id = ?
    `),
    setUserRole: d.prepare(`
      UPDATE users SET role = ? WHERE id = ?
    `),
    deleteUser: d.prepare(`DELETE FROM users WHERE id = ?`),

    // ---- sessions ----
    insertSession: d.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `),
    findSession: d.prepare(`
      SELECT s.id AS sid, s.user_id, s.expires_at, s.created_at,
             u.email, u.role
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?
    `),
    deleteSession: d.prepare(`DELETE FROM sessions WHERE id = ?`),
    deleteSessionsForUser: d.prepare(`DELETE FROM sessions WHERE user_id = ?`),
    purgeExpiredSessions: d.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),

    // ---- lists ----
    insertList: d.prepare(`
      INSERT INTO lists (user_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    findListById: d.prepare(`
      SELECT id, user_id, name, created_at, updated_at
      FROM lists WHERE id = ?
    `),
    findListByUserAndName: d.prepare(`
      SELECT id, user_id, name, created_at, updated_at
      FROM lists WHERE user_id = ? AND name = ?
    `),
    findListsByUser: d.prepare(`
      SELECT l.id, l.user_id, l.name, l.created_at, l.updated_at,
             (SELECT COUNT(*) FROM list_items WHERE list_id = l.id) AS item_count
      FROM lists l
      WHERE l.user_id = ?
      ORDER BY l.updated_at DESC
    `),
    updateListName: d.prepare(`
      UPDATE lists SET name = ?, updated_at = ? WHERE id = ?
    `),
    touchList: d.prepare(`
      UPDATE lists SET updated_at = ? WHERE id = ?
    `),
    deleteList: d.prepare(`DELETE FROM lists WHERE id = ?`),

    insertListItem: d.prepare(`
      INSERT OR IGNORE INTO list_items (list_id, ticker, added_at)
      VALUES (?, ?, ?)
    `),
    deleteListItem: d.prepare(`
      DELETE FROM list_items WHERE list_id = ? AND ticker = ?
    `),
    findListItems: d.prepare(`
      SELECT li.list_id, li.ticker, li.added_at,
             CASE WHEN c.ticker IS NOT NULL THEN c.ticker
                  WHEN c2.ticker IS NOT NULL THEN c2.ticker
                  ELSE NULL END AS resolved_ticker,
             COALESCE(c2.name, c.name) AS name,
             COALESCE(c2.kind, c.kind) AS kind,
             COALESCE(c2.profile, c.profile) AS profile,
             COALESCE(c2.country, c.country) AS country,
             (SELECT r.score
              FROM requests r
              WHERE r.ticker = COALESCE(c.ticker, c2.ticker, li.ticker)
                AND r.status = 'done' AND r.score IS NOT NULL
              ORDER BY r.completed_at DESC
              LIMIT 1) AS score,
             (SELECT r.total
              FROM requests r
              WHERE r.ticker = COALESCE(c.ticker, c2.ticker, li.ticker)
                AND r.status = 'done' AND r.score IS NOT NULL
              ORDER BY r.completed_at DESC
              LIMIT 1) AS total,
             (SELECT r.completed_at
              FROM requests r
              WHERE r.ticker = COALESCE(c.ticker, c2.ticker, li.ticker)
                AND r.status = 'done' AND r.score IS NOT NULL
              ORDER BY r.completed_at DESC
              LIMIT 1) AS evaluated_at
      FROM list_items li
      LEFT JOIN companies c ON c.ticker = li.ticker
      LEFT JOIN companies c2 ON UPPER(c2.name) = UPPER(li.ticker)
      WHERE li.list_id = ?
      ORDER BY li.added_at DESC
    `),
    listAllLists: d.prepare(`
      SELECT l.id, l.user_id, l.name, l.created_at, l.updated_at,
             u.email AS user_email
      FROM lists l
      LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.updated_at DESC
      LIMIT ?
    `),
  };
}

// Returns one row per ticker that has at least one cached factor, plus the
// max evaluated_at across all of that ticker's factors. Used by the dynamic
// /sitemap.xml route. Cheap query (single GROUP BY scan over the small
// evaluation_factors table) — no caching layer needed.
export function listTickersWithFactors() {
  const d = getDb();
  return d.prepare(`
    SELECT ticker, MAX(evaluated_at) AS last_evaluated_at
    FROM evaluation_factors
    WHERE ticker IS NOT NULL
    GROUP BY ticker
    ORDER BY last_evaluated_at DESC
  `).all();
}

// Factors for a ticker whose question_hash is in the given set, ordered by
// idx ASC. Built at runtime because the IN-list length varies per kind
// (typically ~24). The ix_evaluation_factors_ticker_idx index handles the
// ticker+idx ordering; the question_hash filter is selective enough that the
// full scan stays fast for small question sets.
export function factorsByTickerAndHashes(ticker, hashes) {
  const d = getDb();
  if (!ticker || !Array.isArray(hashes) || hashes.length === 0) return [];
  const placeholders = hashes.map(() => '?').join(',');
  const sql = `
    SELECT ticker, idx, question, question_hash, score, reasoning, error, evaluated_at
    FROM evaluation_factors
    WHERE ticker = ? AND question_hash IN (${placeholders})
    ORDER BY idx ASC
  `;
  return d.prepare(sql).all(ticker, ...hashes);
}

export function getDb() {
  if (!db) initDb();
  return db;
}

export function getStatements() {
  if (!stmts) initDb();
  return stmts;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}