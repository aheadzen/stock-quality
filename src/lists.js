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

const STOPWORDS = new Set(['LTD', 'LIMITED', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION',
  'COMPANY', 'CO', 'PLC', 'AG', 'SA', 'NV', 'THE', 'AND']);

function firstSignificantWord(input) {
  if (!input) return null;
  const cleaned = String(input).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ');
  const words = cleaned.split(/\s+/).filter((w) => w && !STOPWORDS.has(w) && w.length >= 3);
  if (words.length === 0) return null;
  // Longest word is usually the most distinctive.
  return words.sort((a, b) => b.length - a.length)[0];
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
  const db = getDb();
  const txn = db.transaction(() => {
    for (const raw of tickers) {
      const rawText = (raw || '').toString().trim();
      if (!rawText) continue;
      const upper = rawText.toUpperCase();
      let ticker = null;
      // 1. Ticker-shaped input: try direct hit on companies.ticker
      if (/^[A-Z][A-Z0-9.\-]{0,5}$/.test(upper)) {
        const hit = s.findCompany.get(upper);
        if (hit) ticker = hit.ticker;
      }
      // 2. Exact name match (case-insensitive) against cached companies
      if (!ticker) {
        const hit = s.findCompanyByName.get(upper);
        if (hit) ticker = hit.ticker;
      }
      // 3. Fuzzy: first significant word matches LIKE in companies.name
      if (!ticker) {
        const word = firstSignificantWord(upper);
        if (word) {
          const hit = db.prepare(
            `SELECT ticker FROM companies WHERE UPPER(name) LIKE ? LIMIT 1`
          ).get(`%${word}%`);
          if (hit) ticker = hit.ticker;
        }
      }
      // 4. Last resort: store raw verbatim; read-time fallback will re-try.
      if (!ticker) ticker = upper;
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