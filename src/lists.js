// Per-user private lists. Each list is uniquely named per user (UNIQUE
// constraint). Items are tickers; the export joins the latest evaluation
// factors/requests to fill the score columns.
//
// CSV export follows the spec: prefix cells starting with =, +, -, @, tab, CR
// with a single quote to block Excel formula injection.

import { getDb, getStatements, initDb } from './db.js';

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
  return s.findListItems.all(listId);
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
  const now = Date.now();
  let inserted = 0;
  const txn = getDb().transaction(() => {
    for (const raw of tickers) {
      const ticker = (raw || '').toString().trim().toUpperCase();
      if (!ticker) continue;
      // INSERT OR IGNORE so re-adding an existing ticker is a no-op.
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
  initDb();
  const db = getDb();
  // Pull one row per (ticker, list) joining the latest request score and most
  // recent factor evaluated_at. The SELECT coalesces NULLs from "no data yet"
  // cleanly so the CSV has empty cells rather than 'undefined'.
  const rows = db.prepare(`
    SELECT
      li.ticker,
      li.added_at,
      c.name,
      c.kind,
      c.country,
      (
        SELECT r.score
        FROM requests r
        WHERE r.ticker = li.ticker AND r.status = 'done' AND r.score IS NOT NULL
        ORDER BY r.completed_at DESC
        LIMIT 1
      ) AS score,
      (
        SELECT r.total
        FROM requests r
        WHERE r.ticker = li.ticker AND r.status = 'done' AND r.score IS NOT NULL
        ORDER BY r.completed_at DESC
        LIMIT 1
      ) AS total,
      (
        SELECT MAX(ef.evaluated_at)
        FROM evaluation_factors ef
        WHERE ef.ticker = li.ticker
      ) AS evaluated_at
    FROM list_items li
    LEFT JOIN companies c ON c.ticker = li.ticker
    WHERE li.list_id = ?
    ORDER BY li.added_at DESC
  `).all(listId);
  return rows;
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
    out.push(csvRow([
      r.ticker,
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