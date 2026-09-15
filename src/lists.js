// Per-user private lists. Each list is uniquely named per user (UNIQUE
// constraint). Items are tickers; the export joins the latest evaluation
// factors/requests to fill the score columns.
//
// CSV export follows the spec: prefix cells starting with =, +, -, @, tab, CR
// with a single quote to block Excel formula injection.

import { getDb, getStatements, initDb } from './db.js';

const STOPWORDS = new Set(['LTD', 'LIMITED', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION',
  'COMPANY', 'CO', 'PLC', 'AG', 'SA', 'NV', 'THE', 'AND']);

// Longest non-stopword ≥3 chars in the input — usually the most distinctive
// token (e.g. "LAXMI" from "LAXMI DENTAL LTD.").
function firstSignificantWord(input) {
  if (!input) return null;
  const cleaned = String(input).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ');
  const words = cleaned.split(/\s+/).filter((w) => w && !STOPWORDS.has(w) && w.length >= 3);
  if (words.length === 0) return null;
  return words.sort((a, b) => b.length - a.length)[0];
}

// Shared 3-tier resolution used by addItems, getListItems, and the backfill:
// (1) ticker-shape + direct hit, (2) exact name match, (3) LIKE on first
// significant word. Returns null when nothing matches.
export function resolveToTicker(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  if (!upper) return null;
  initDb();
  const s = getStatements();
  const db = getDb();
  if (/^[A-Z][A-Z0-9.\-]{0,5}$/.test(upper)) {
    const hit = s.findCompany.get(upper);
    if (hit) return hit.ticker;
  }
  const byName = s.findCompanyByName.get(upper);
  if (byName) return byName.ticker;
  const word = firstSignificantWord(upper);
  if (word) {
    const fuzzy = db.prepare(
      `SELECT ticker FROM companies WHERE UPPER(name) LIKE ? LIMIT 1`
    ).get(`%${word}%`);
    if (fuzzy) return fuzzy.ticker;
  }
  return null;
}

// One-time backfill: replace name-stored list_items rows with their resolved
// ticker so the PRIMARY KEY (list_id, ticker) enforces uniqueness going
// forward. Idempotent — re-running on already-resolved rows is a no-op.
// Called from initDb() in db.js via the migrations hook below.
export function backfillListItemsToTickers() {
  initDb();
  const db = getDb();
  const rows = db.prepare(`SELECT list_id, ticker FROM list_items`).all();
  let changed = 0;
  for (const row of rows) {
    const resolved = resolveToTicker(row.ticker);
    if (!resolved || resolved === row.ticker) continue;
    const added = db.prepare(
      `SELECT added_at FROM list_items WHERE list_id = ? AND ticker = ?`
    ).get(row.list_id, row.ticker);
    if (!added) continue;
    // Replace the row in place. SQLite's INSERT OR IGNORE on PRIMARY KEY
    // conflict + DELETE first gives us atomic dedupe.
    const replace = db.transaction(() => {
      db.prepare(`DELETE FROM list_items WHERE list_id = ? AND ticker = ?`)
        .run(row.list_id, row.ticker);
      db.prepare(`INSERT OR IGNORE INTO list_items (list_id, ticker, added_at) VALUES (?, ?, ?)`)
        .run(row.list_id, resolved, added.added_at);
    });
    replace();
    changed += 1;
  }
  return changed;
}

// ---- CRUD ----

export function createList(userId, name) {
  if (!userId) throw new Error('userId is required');
  const trimmed = (name || '').toString().trim();
  if (!trimmed) throw new Error('List name is required');
  if (trimmed.length > 80) throw new Error('List name must be 80 characters or fewer');
  initDb();
  const s = getStatements();
  const now = Date.now();
  try {
    const id = s.insertList.run(userId, trimmed, now, now).lastInsertRowid;
    return Number(id);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new Error(`A list named "${trimmed}" already exists`);
    }
    throw err;
  }
}

export function getListsForUser(userId) {
  if (!userId) return [];
  initDb();
  const s = getStatements();
  return s.findListsByUser.all(userId);
}

export function getListById(id, userId) {
  if (!id || !userId) return null;
  initDb();
  const s = getStatements();
  const row = s.findListById.get(id);
  if (!row || row.user_id !== userId) return null;
  return row;
}

export function getListItems(listId) {
  initDb();
  const s = getStatements();
  const rows = s.findListItems.all(listId);
  // Fuzzy fallback: items where exact ticker + exact name match didn't
  // resolve still might match a company whose name contains a key word from
  // the stored input. Strip legal suffixes and try LIKE.
  const needsResolve = rows.filter((r) => !r.resolved_ticker);
  if (needsResolve.length === 0) return rows;
  const db = getDb();
  for (const row of needsResolve) {
    const word = firstSignificantWord(row.ticker);
    if (!word) continue;
    const hit = db.prepare(
      `SELECT ticker, name, kind, profile, country FROM companies
       WHERE UPPER(name) LIKE ? LIMIT 1`
    ).get(`%${word}%`);
    if (hit) {
      row.resolved_ticker = hit.ticker;
      row.name = row.name ?? hit.name;
      row.kind = row.kind ?? hit.kind;
      row.profile = row.profile ?? hit.profile;
      row.country = row.country ?? hit.country;
      // Also backfill score/total from the now-known ticker.
      const scoreRow = db.prepare(`
        SELECT score, total, completed_at AS evaluated_at
        FROM requests
        WHERE ticker = ? AND status = 'done' AND score IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `).get(hit.ticker);
      if (scoreRow) {
        row.score = scoreRow.score;
        row.total = scoreRow.total;
        row.evaluated_at = scoreRow.evaluated_at;
      }
    }
  }
  return rows;
}

export function updateListName(id, userId, name) {
  const trimmed = (name || '').toString().trim();
  if (!trimmed) throw new Error('List name is required');
  if (trimmed.length > 80) throw new Error('List name must be 80 characters or fewer');
  initDb();
  const s = getStatements();
  const row = s.findListById.get(id);
  if (!row || row.user_id !== userId) return 0;
  try {
    const r = s.updateListName.run(trimmed, Date.now(), id);
    return r.changes;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new Error(`A list named "${trimmed}" already exists`);
    }
    throw err;
  }
}

export function deleteList(id, userId) {
  initDb();
  const s = getStatements();
  const row = s.findListById.get(id);
  if (!row || row.user_id !== userId) return 0;
  return s.deleteList.run(id).changes;
}

export function addItems(listId, userId, tickers) {
  if (!listId || !userId) throw new Error('listId and userId are required');
  if (!Array.isArray(tickers) || tickers.length === 0) return 0;
  initDb();
  const s = getStatements();
  const row = s.findListById.get(listId);
  if (!row || row.user_id !== userId) throw new Error('List not found');
  const db = getDb();
  const now = Date.now();
  // Resolve + dedupe inputs first, then delete any existing rows in this list
  // that resolve to one of the new tickers (catches name-stored duplicates).
  const resolvedSet = new Set();
  for (const raw of tickers) {
    const rawText = (raw || '').toString().trim();
    if (!rawText) continue;
    const upper = rawText.toUpperCase();
    const ticker = resolveToTicker(upper) || upper;
    resolvedSet.add(ticker);
  }
  let inserted = 0;
  const txn = db.transaction(() => {
    // Drop name-stored rows whose resolved ticker is in our incoming set.
    for (const ticker of resolvedSet) {
      const conflicts = db.prepare(
        `SELECT ticker FROM list_items WHERE list_id = ?`
      ).all(listId);
      for (const c of conflicts) {
        if (c.ticker === ticker) continue;
        if (resolveToTicker(c.ticker) === ticker) {
          db.prepare(`DELETE FROM list_items WHERE list_id = ? AND ticker = ?`)
            .run(listId, c.ticker);
        }
      }
    }
    for (const ticker of resolvedSet) {
      const r = s.insertListItem.run(listId, ticker, now);
      if (r.changes > 0) inserted += 1;
    }
    s.touchList.run(now, listId);
  });
  txn();
  return inserted;
}

export function removeItem(listId, userId, ticker) {
  if (!listId || !userId || !ticker) return 0;
  initDb();
  const s = getStatements();
  const row = s.findListById.get(listId);
  if (!row || row.user_id !== userId) return 0;
  const r = s.deleteListItem.run(listId, ticker.toString().trim().toUpperCase());
  if (r.changes > 0) s.touchList.run(Date.now(), listId);
  return r.changes;
}

export function listAllLists(limit = 50) {
  initDb();
  const s = getStatements();
  return s.listAllLists.all(limit);
}

// ---- CSV export ----

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

function csvSafe(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (s.length > 0 && FORMULA_PREFIXES.has(s[0])) s = `'${s}`;
  // Quote anything containing comma, newline, or double quote.
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvSafe).join(',');
}

function isoOrEmpty(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toISOString();
  } catch {
    return '';
  }
}

function buildExportRows(listId) {
  // Reuse getListItems so the export picks up the same 3-tier ticker
  // resolution as the UI. Items added as company names would otherwise miss
  // the requests.ticker join and export blank scores.
  return getListItems(listId);
}

export function exportListCsv(listId, userId) {
  initDb();
  const s = getStatements();
  const list = s.findListById.get(listId);
  if (!list || list.user_id !== userId) return null;
  const rows = buildExportRows(listId);
  const header = ['Ticker', 'Company', 'Score', 'Total', 'Percent', 'Country', 'Kind', 'Evaluated At'];
  const out = [csvRow(header)];
  for (const r of rows) {
    const score = r.score;
    const total = r.total;
    let pct = '';
    if (typeof score === 'number' && typeof total === 'number' && total > 0) {
      pct = `${((score / total) * 100).toFixed(1)}%`;
    }
    // Ticker column shows the resolved ticker when the user added an input
    // that needed name/LIKE resolution; raw input goes through only when no
    // resolution succeeded.
    const exportTicker = r.resolved_ticker ?? r.ticker;
    out.push(csvRow([
      exportTicker,
      r.name ?? '',
      score ?? '',
      total ?? '',
      pct,
      r.country ?? '',
      r.kind ?? '',
      isoOrEmpty(r.evaluated_at),
    ]));
  }
  return { name: list.name, csv: out.join('\r\n') + '\r\n' };
}