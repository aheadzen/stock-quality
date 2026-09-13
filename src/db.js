// SQLite layer for stock-quality. Single shared connection (better-sqlite3 is
// synchronous and thread-safe for single-process use). Tables live in this
// module's migrations; prepared statements are exported for callers.

import path from 'node:path';
import fs from 'node:fs';
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
  idx INTEGER,
  question TEXT,
  score INTEGER,
  reasoning TEXT,
  error TEXT
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
  completed_at INTEGER
);
`;

export function initDb() {
  if (db) return db;
  ensureDir();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  stmts = prepare(db);
  return db;
}

function prepare(d) {
  return {
    upsertCompany: d.prepare(`
      INSERT INTO companies (ticker, name, kind, profile, price, currency, exchange, notes, fetched_at)
      VALUES (@ticker, @name, @kind, @profile, @price, @currency, @exchange, @notes, @fetched_at)
      ON CONFLICT(ticker) DO UPDATE SET
        name=excluded.name,
        kind=excluded.kind,
        profile=excluded.profile,
        price=excluded.price,
        currency=excluded.currency,
        exchange=excluded.exchange,
        notes=excluded.notes,
        fetched_at=excluded.fetched_at
    `),
    findCompany: d.prepare(`SELECT * FROM companies WHERE ticker = ?`),
    insertEvaluation: d.prepare(`
      INSERT INTO evaluations (ticker, questions_hash, score, total, evaluated_at, expires_at)
      VALUES (@ticker, @questions_hash, @score, @total, @evaluated_at, @expires_at)
      ON CONFLICT(ticker, questions_hash) DO UPDATE SET
        score=excluded.score,
        total=excluded.total,
        evaluated_at=excluded.evaluated_at,
        expires_at=excluded.expires_at
    `),
    findFreshEvaluation: d.prepare(`
      SELECT score, total, evaluated_at, expires_at
      FROM evaluations
      WHERE ticker = ? AND questions_hash = ? AND expires_at > ?
    `),
    findEvaluationAny: d.prepare(`
      SELECT id, score, total, evaluated_at, expires_at
      FROM evaluations
      WHERE ticker = ? AND questions_hash = ?
    `),
    deleteFactorsForEvaluation: d.prepare(`DELETE FROM evaluation_factors WHERE evaluation_id = ?`),
    insertFactor: d.prepare(`
      INSERT INTO evaluation_factors (evaluation_id, idx, question, score, reasoning, error)
      VALUES (@evaluation_id, @idx, @question, @score, @reasoning, @error)
    `),

    insertRequest: d.prepare(`
      INSERT INTO requests (input, ticker, status, score, total, created_at, updated_at)
      VALUES (@input, @ticker, @status, @score, @total, @created_at, @updated_at)
    `),
    getRequest: d.prepare(`SELECT * FROM requests WHERE id = ?`),
    listOngoing: d.prepare(`
      SELECT * FROM (
        SELECT r.*,
          c.name AS company_name, c.kind AS company_kind, c.profile AS company_profile,
          (SELECT MAX(evaluated_at) FROM evaluations WHERE ticker = r.ticker) AS evaluated_at,
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

    bestByHash: d.prepare(`
      SELECT r.id, r.input, r.ticker, c.name, c.kind, c.profile, r.status, r.score, r.total, r.completed_at, e.evaluated_at
      FROM requests r
      JOIN evaluations e ON e.ticker = r.ticker AND e.questions_hash = ?
      LEFT JOIN companies c ON c.ticker = r.ticker
      WHERE r.status = 'done' AND r.score IS NOT NULL
      ORDER BY r.score DESC, r.completed_at DESC
      LIMIT ?
    `),
    bestByHashes: d.prepare(`
      SELECT r.id, r.input, r.ticker, c.name, c.kind, c.profile, r.status, r.score, r.total, r.completed_at, e.evaluated_at
      FROM requests r
      JOIN evaluations e ON e.ticker = r.ticker
      LEFT JOIN companies c ON c.ticker = r.ticker
      WHERE r.status = 'done'
        AND r.score IS NOT NULL
        AND (e.questions_hash = ? OR e.questions_hash = ?)
      ORDER BY r.score DESC, r.completed_at DESC
      LIMIT ?
    `),
    factorsByTickerHash: d.prepare(`
      SELECT f.idx, f.question, f.score, f.reasoning, f.error
      FROM evaluation_factors f
      JOIN evaluations e ON e.id = f.evaluation_id
      WHERE e.ticker = ? AND e.questions_hash = ?
      ORDER BY f.idx ASC
    `),
  };
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