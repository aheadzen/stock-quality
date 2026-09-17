// In-memory index of NSE-listed Indian stocks. Parsed once at server boot from
// `tickers/EQUITY_L.csv` (NSE main board) and `tickers/SME_EQUITY_L.csv` (NSE
// SME platform). Used by:
//   - GET /api/stocks?q=…  (autocomplete for the home form)
//   - enqueueRequest       (skip LLM/Tavily for known tickers)
//
// We intentionally do NOT touch the `companies` SQLite table here — those rows
// are still written by saveCompany() on the normal eval path so the rest of
// the app (best list, list items, report) keeps working unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/indianStocks.js → ../../tickers/*.csv
const TICKERS_DIR = path.resolve(__dirname, '..', 'tickers');

const MAIN_FILE = 'EQUITY_L.csv';
const SME_FILE = 'SME_EQUITY_L.csv';

let byTicker = new Map();      // SYMBOL (upper) → row
let allRows = [];              // every parsed row, kept for substring search
let loaded = false;
let loadError = null;

function parseCsv(text) {
  // Minimal RFC 4180-ish parser: handles quoted fields with embedded commas
  // and "" escapes. The NSE files don't use either today but keep the parser
  // honest for future format changes.
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (field.length || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
      // swallow \r\n as a single terminator
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadFromFile(filename, isSME) {
  const full = path.join(TICKERS_DIR, filename);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    loadError = err;
    return;
  }
  const rows = parseCsv(text);
  if (rows.length === 0) return;

  // Header detection: be liberal — both "NAME OF COMPANY" and "NAME_OF_COMPANY"
  // appear across the two files. Find whichever column name is present.
  const header = rows[0].map((h) => h.trim());
  const symbolIdx = header.findIndex((h) => h.toUpperCase() === 'SYMBOL');
  const nameIdx = header.findIndex((h) =>
    h.toUpperCase().replace(/[^A-Z]/g, '') === 'NAMEOFCOMPANY'
  );
  const seriesIdx = header.findIndex((h) => h.toUpperCase() === 'SERIES');
  if (symbolIdx < 0 || nameIdx < 0) {
    loadError = new Error(`${filename}: missing SYMBOL/NAME column (have ${header.join(',')})`);
    return;
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ticker = (r[symbolIdx] || '').trim().toUpperCase();
    const name = (r[nameIdx] || '').trim();
    if (!ticker || !name) continue;
    // First-write wins: if a symbol appears in both files (it shouldn't, but
    // be defensive), keep the main-board entry to avoid duplicates.
    if (byTicker.has(ticker)) continue;
    const series = seriesIdx >= 0 ? (r[seriesIdx] || '').trim() : '';
    allRows.push({
      ticker,
      name,
      isSME,
      series,
      exchange: isSME ? 'NSE SME' : 'NSE',
    });
    byTicker.set(ticker, allRows[allRows.length - 1]);
  }
}

export function loadIndianStocks() {
  byTicker = new Map();
  allRows = [];
  loadError = null;
  loadFromFile(MAIN_FILE, false);
  loadFromFile(SME_FILE, true);
  loaded = true;
  if (loadError) {
    // Don't throw — the rest of the app still works without the index, the
    // home form just won't get autocomplete suggestions and tickers will fall
    // through to the LLM path. Surface via loadIndianStocksStatus() for the
    // server log.
    return { count: allRows.length, error: loadError.message };
  }
  return { count: allRows.length };
}

export function loadIndianStocksStatus() {
  return {
    loaded,
    count: allRows.length,
    error: loadError ? loadError.message : null,
  };
}

// Case-insensitive prefix/substring match on ticker OR name, with a Levenshtein
// fuzzy fallback for typos. The query is split into whitespace tokens; every
// token must match somewhere in (ticker+' '+name) — "tata motors" matches
// Tata Motors Limited but not just "tata".
//
// Two passes, exact wins:
//   1. Substring (current behavior). Sorted: ticker-prefix > name-prefix >
//      shorter ticker.
//   2. Levenshtein. Only runs when pass 1 didn't fill `limit`. Per-token
//      threshold: 1 edit for tokens ≤3 chars (e.g. "tat"), 2 edits for longer
//      tokens (e.g. "rilince" → "RELIANCE" needs 2). Sorted: lowest total edit
//      distance > ticker-prefix > shorter ticker.
//
// 3149 rows × ~6 words × 8×8 DP ≈ <100ms worst case — fine for an async
// /api/stocks handler.
export function searchIndianStocks(rawQuery, limit = 20) {
  if (!loaded) loadIndianStocks();
  const q = (rawQuery || '').trim();
  if (q.length < 1) return [];
  const qUpper = q.toUpperCase();
  const tokens = qUpper.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Pass 1: substring (every token must appear in the haystack)
  const exactMatches = [];
  for (const row of allRows) {
    const hay = `${row.ticker} ${row.name.toUpperCase()}`;
    let ok = true;
    for (const t of tokens) {
      if (!hay.includes(t)) { ok = false; break; }
    }
    if (!ok) continue;
    exactMatches.push(row);
  }

  const prefixClass = (row) => {
    if (row.ticker.startsWith(qUpper)) return 0;
    if (row.name.toUpperCase().startsWith(qUpper)) return 1;
    return 2;
  };
  exactMatches.sort((a, b) => {
    const ap = prefixClass(a), bp = prefixClass(b);
    return ap - bp || a.ticker.length - b.ticker.length;
  });

  const results = [];
  const seen = new Set();
  for (const row of exactMatches) {
    if (results.length >= limit) break;
    results.push(row);
    seen.add(row);
  }

  // Pass 2: fuzzy fallback (only when exact didn't fill the cap)
  if (results.length < limit) {
    const FUZZY_THRESHOLD = 2;
    const fuzzy = [];
    for (const row of allRows) {
      if (seen.has(row)) continue;
      const words = `${row.ticker} ${row.name.toUpperCase()}`.split(/\s+/);
      // Track per-token best edit distance AND whether the best hit was the
      // ticker itself. Ticker hits break ties so "rilince" ranks RELIANCE
      // (ticker match, dist=2) above RCOM (only "Reliance" in name, dist=2).
      let worstDist = 0;
      let tickerHits = 0;
      let matched = true;
      for (const t of tokens) {
        const perTokenMax = t.length <= 3 ? 1 : FUZZY_THRESHOLD;
        let minDist = Infinity;
        let minDistOnTicker = false;
        for (let wi = 0; wi < words.length; wi++) {
          const w = words[wi];
          if (Math.abs(t.length - w.length) > perTokenMax) continue;
          const d = levenshtein(t, w);
          const onTicker = wi === 0;
          if (d < minDist || (d === minDist && onTicker && !minDistOnTicker)) {
            minDist = d;
            minDistOnTicker = onTicker;
          }
          if (minDist === 0) break;
        }
        if (minDist > perTokenMax) { matched = false; break; }
        if (minDist > worstDist) worstDist = minDist;
        if (minDistOnTicker && minDist <= perTokenMax) tickerHits++;
      }
      if (matched) fuzzy.push({ row, dist: worstDist, tickerHits });
    }

    fuzzy.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      if (a.tickerHits !== b.tickerHits) return b.tickerHits - a.tickerHits;
      const ap = prefixClass(a.row), bp = prefixClass(b.row);
      return ap - bp || a.row.ticker.length - b.row.ticker.length;
    });

    for (const f of fuzzy) {
      if (results.length >= limit) break;
      if (seen.has(f.row)) continue;
      results.push(f.row);
      seen.add(f.row);
    }
  }

  return results.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    exchange: row.exchange,
    isSME: row.isSME,
  }));
}

// Standard Wagner–Fischer DP. Returns Infinity if the length gap already
// exceeds the threshold, so callers can short-circuit cheaply.
function levenshtein(a, b) {
  if (a === b) return 0;
  let m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Rolling two-row DP keeps memory at O(min(m,n)). Swap so m <= n.
  if (m > n) {
    const ta = a; a = b; b = ta;
    const tm = m; m = n; n = tm;
  }
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
    // Bounded early-out: if every cell in this row is ≥ 3, the caller has
    // already passed its threshold of 2 and there's no point finishing.
    if (rowMin > 2) return Infinity;
  }
  return prev[n];
}

// Look up a known ticker in the in-memory index. Returns null if not present.
export function findIndianStock(ticker) {
  if (!loaded) loadIndianStocks();
  if (!ticker) return null;
  return byTicker.get(String(ticker).trim().toUpperCase()) || null;
}

// Build a stub company record suitable for saveCompany() and the rest of the
// queue pipeline. The minimal subset is enough for:
//   - skipEnrichment=true → processRequest skips Tavily
//   - kind='listed'        → loadQuestions('listed') returns the 25 company Qs
//   - country='IN'         → UI badge + listing on the best list
// We leave profile and price blank — they will be filled in if a future eval
// refreshes the row from the LLM path. profile stays empty; price stays null
// (so the dashboard shows no price rather than a wrong one).
export function buildIndianCompany(row) {
  return {
    kind: 'listed',
    ticker: row.ticker,
    name: row.name,
    profile: '',
    price: null,
    currency: 'INR',
    exchange: row.exchange,
    country: 'IN',
    notes: null,
    skipEnrichment: true,
  };
}