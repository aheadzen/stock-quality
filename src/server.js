#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './config.js';
import { initDb, getDb, getStatements, factorsByTickerAndHashes } from './db.js';
import { loadQuestions } from './questions.js';
import { questionHash, findCompany } from './cache.js';
import {
  enqueueRequest,
  startProcessor,
  stopProcessor,
  beginShutdown,
  resetErrorRequest,
  dismissRequest,
  getOngoing,
  getRecentErrors,
  getBest,
  isPaused,
} from './queue.js';
import { logError, logInfo, logWarn, getLogPath } from './logger.js';
import { getSettings } from './settings.js';
import {
  attachUser,
  requireAuth,
  requireAdmin,
  batchRateLimit,
  COOKIE_NAME,
  handleRegister,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  getBatchSizeLimit,
} from './auth.js';
import {
  createList,
  getListsForUser,
  getListById,
  getListItems,
  updateListName,
  deleteList,
  addItems,
  removeItem,
  exportListCsv,
  listAllLists,
} from './lists.js';
import {
  findUserById,
  setUserRole,
  deleteUser,
  listUsers,
} from './users.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve('./public');
// Public preview exposes the first N factors of a ticker's evaluation so the
// detail page can tease the analysis without a passcode. The remaining
// factors stay locked behind POST /api/report. Bump this number with care —
// every preview row is one more question's text + reasoning visible without
// authentication.
const PREVIEW_FACTOR_LIMIT = 3;

// Memoize the per-kind question counts. The UI polls /api/best every 3s and
// questions.json only changes at restart (server boot), so loading it once
// per kind at startup is correct.
let _companyQuestionCount = null;
let _cryptoQuestionCount = null;
function kindCounts() {
  if (_companyQuestionCount === null) _companyQuestionCount = loadQuestions('company').length;
  if (_cryptoQuestionCount === null) _cryptoQuestionCount = loadQuestions('crypto').length;
  return [_companyQuestionCount, _cryptoQuestionCount];
}

// ---------- helpers ----------

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8' },
    JSON.stringify(obj)
  );
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    send(res, 200, { 'Content-Type': contentTypeFor(abs) }, data);
  });
}

async function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function readTextBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function shapeRequestRow(r) {
  // Sanitize the error message for the UI. The full message is in
  // data/stock-quality.log; the user only needs a short, non-technical hint.
  let errorMessage = null;
  if (r.status === 'error' && r.error_message) {
    errorMessage = 'Couldn’t evaluate this ticker. Try again?';
  }
  return {
    id: r.id,
    input: r.input,
    ticker: r.ticker,
    status: r.status,
    score: r.score,
    total: r.total,
    error_message: errorMessage,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    evaluated_at: r.evaluated_at ?? null,
    name: r.company_name ?? null,
    kind: r.company_kind ?? null,
    profile: r.company_profile ?? null,
    country: r.company_country ?? null,
  };
}

// ---------- routes ----------

async function handlePostRequest(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  // Multi-stock: requires auth + rate-limit. Returns per-input results so a
  // single bad ticker doesn't kill the whole batch.
  if (Array.isArray(body.inputs)) {
    const user = requireAuth(req, res);
    if (!user) return; // 401 already sent
    const limit = batchRateLimit(user.id);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return sendJson(res, 429, { error: 'Batch rate limit exceeded. Try again later.' });
    }
    const cap = getBatchSizeLimit();
    const raw = body.inputs.slice(0, cap);
    if (raw.length === 0) {
      return sendJson(res, 400, { error: 'inputs must be a non-empty array' });
    }
    const seen = new Set();
    const inputs = [];
    for (const v of raw) {
      const t = (v || '').toString().trim();
      if (!t) continue;
      const key = t.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push(t);
    }
    if (inputs.length === 0) {
      return sendJson(res, 400, { error: 'inputs must contain at least one non-empty ticker' });
    }
    const results = [];
    for (const inp of inputs) {
      try {
        const r = await enqueueRequest(inp, { userId: user.id });
        results.push({
          input: inp,
          id: r.id,
          status: r.status,
          ticker: r.ticker,
          score: r.score,
          total: r.total,
        });
      } catch (err) {
        results.push({
          input: inp,
          status: 'error',
          error: err.message || String(err),
        });
      }
    }
    logInfo('api', `POST /api/requests batch by ${user.email} count=${inputs.length}`);
    return sendJson(res, 200, { results });
  }

  // Single-stock: anonymous OK (backward compat).
  const input = (body.input || '').toString().trim();
  if (!input) return sendJson(res, 400, { error: 'input is required' });
  const userId = req.user?.id ?? null;
  try {
    const result = await enqueueRequest(input, { userId });
    logInfo('api', `POST /api/requests input="${input}" user=${userId ?? 'anon'} → ${result.status}${result.status === 'done' ? ` (${result.score}/${result.total})` : ''}`);
    return sendJson(res, 200, result);
  } catch (err) {
    logError('api', `POST /api/requests input="${input}" threw`, err);
    return sendJson(res, 500, { error: err.message || String(err) });
  }
}

function handleGetRequests(req, res, url) {
  const RECENT_LIMIT = 15;
  const ERROR_LIMIT = 5;
  const status = url.searchParams.get('status');
  // Anon: empty list. Legacy NULL user_id rows are visible only to admin
  // (their per-user filter naturally excludes them).
  if (!req.user) {
    return sendJson(res, 200, { requests: [], errors: [], paused: isPaused() });
  }
  if (status === 'errors') {
    const rows = getRecentErrorsFor(req.user, ERROR_LIMIT).map(shapeRequestRow);
    return sendJson(res, 200, { requests: rows, paused: isPaused() });
  }
  const ongoing = getOngoingFor(req.user, RECENT_LIMIT).map(shapeRequestRow);
  const errors = getRecentErrorsFor(req.user, ERROR_LIMIT).map(shapeRequestRow);
  return sendJson(res, 200, {
    requests: ongoing,
    errors,
    paused: isPaused(),
  });
}

// Admin sees everything (including legacy NULL user_id rows); regular users
// see only their own rows.
function isAdminUser(user) {
  return user?.role === 'admin';
}

function getOngoingFor(user, limit) {
  initDb();
  const db = getDb();
  if (isAdminUser(user)) return getOngoing(limit);
  return db.prepare(`
    SELECT r.*,
           c.name AS company_name, c.kind AS company_kind, c.profile AS company_profile,
           c.country AS company_country,
           (SELECT MAX(evaluated_at) FROM evaluation_factors WHERE ticker = r.ticker) AS evaluated_at
    FROM requests r
    LEFT JOIN companies c ON c.ticker = r.ticker
    WHERE r.user_id = ?
      AND r.status IN ('pending','processing','done')
    ORDER BY r.updated_at DESC
    LIMIT ?
  `).all(user.id, limit);
}

function getRecentErrorsFor(user, limit) {
  initDb();
  const db = getDb();
  if (isAdminUser(user)) return getRecentErrors(limit);
  return db.prepare(`
    SELECT * FROM requests
    WHERE status = 'error' AND user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(user.id, limit);
}

function handleGetBest(req, res) {
  // Per-question caching means "complete evaluation" is determined by the
  // count of distinct cached factors matching the current question set for
  // the ticker's kind. Pass the two kind counts into the best-of query.
  const rows = getBest(5, kindCounts()).map((r) => ({
    id: r.id,
    input: r.input,
    ticker: r.ticker,
    name: r.name,
    kind: r.kind,
    profile: r.profile,
    country: r.country ?? null,
    status: r.status,
    score: r.score,
    total: r.total,
    completed_at: r.completed_at,
    evaluated_at: r.evaluated_at ?? null,
  }));
  return sendJson(res, 200, { requests: rows });
}

async function handlePostReportPreview(req, res) {
  // Public preview: returns the company header + the first
  // PREVIEW_FACTOR_LIMIT factors without requiring a passcode. The full
  // report (and remaining factors) still requires POST /api/report with a
  // valid passcode.
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const ticker = (body.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return sendJson(res, 400, { error: 'ticker is required' });

  const company = findCompany(ticker);
  const kind = company?.kind || 'listed';
  const hashes = loadQuestions(kind).map(questionHash);

  // Per-question filter — no more JOIN through evaluations. The ix_evaluation
  // _factors_ticker_idx index gives ordered reads; the IN-list filter is
  // selective enough that the small question set stays fast.
  const rows = factorsByTickerAndHashes(ticker, hashes);
  if (rows.length === 0) {
    return sendJson(res, 404, { error: `No factors for ${ticker} against current questions` });
  }
  const factors = rows.slice(0, PREVIEW_FACTOR_LIMIT).map((f) => ({
    idx: f.idx,
    question: f.question,
    score: f.score,
    reasoning: f.reasoning,
    error: f.error,
  }));
  const total = rows.length;

  logInfo(
    'api',
    `POST /api/report/preview served ${ticker} (${factors.length} of ${total} factors, kind=${kind})`
  );
  return sendJson(res, 200, { ticker, company, factors, total });
}

async function handlePostReport(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const ticker = (body.ticker || '').toString().trim().toUpperCase();
  const passcode = (body.passcode || '').toString().trim();
  if (!ticker) return sendJson(res, 400, { error: 'ticker is required' });
  if (!passcode) return sendJson(res, 400, { error: 'passcode is required' });

  const expected = getSettings().reportPasscode;
  if (passcode !== expected) {
    logWarn('api', `POST /api/report denied for ${ticker} (bad passcode)`);
    return sendJson(res, 403, { error: 'Invalid passcode' });
  }

  // Look up the company kind so we load the matching question set.
  const company = findCompany(ticker);
  const kind = company?.kind || 'listed';
  const hashes = loadQuestions(kind).map(questionHash);

  const rows = factorsByTickerAndHashes(ticker, hashes);
  if (rows.length === 0) {
    return sendJson(res, 404, { error: `No factors for ${ticker} against current questions` });
  }
  const factors = rows.map((f) => ({
    idx: f.idx,
    question: f.question,
    score: f.score,
    reasoning: f.reasoning,
    error: f.error,
  }));

  logInfo('api', `POST /api/report served ${ticker} (${factors.length} factors, kind=${kind})`);
  return sendJson(res, 200, { ticker, company, factors });
}

async function handlePostDelete(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const ticker = (body.ticker || '').toString().trim().toUpperCase();
  const passcode = (body.passcode || '').toString().trim();
  if (!ticker) return sendJson(res, 400, { error: 'ticker is required' });
  if (!passcode) return sendJson(res, 400, { error: 'passcode is required' });

  const expected = getSettings().reportPasscode;
  if (passcode !== expected) {
    logWarn('api', `POST /api/report/delete denied for ${ticker} (bad passcode)`);
    return sendJson(res, 403, { error: 'Invalid passcode' });
  }

  const db = initDb();
  // Wipe everything tied to this ticker so a fresh re-evaluation starts
  // from a clean slate. Order: factors → evaluations → companies → requests.
  // Factors are wiped directly by ticker (the per-question cache is keyed on
  // ticker, not on evaluation_id).
  const counts = db.transaction(() => {
    const factors = db.prepare(`DELETE FROM evaluation_factors WHERE ticker = ?`).run(ticker).changes;
    const evals = db.prepare(`DELETE FROM evaluations WHERE ticker = ?`).run(ticker).changes;
    const company = db.prepare(`DELETE FROM companies WHERE ticker = ?`).run(ticker).changes;
    const requests = db.prepare(`DELETE FROM requests WHERE ticker = ?`).run(ticker).changes;
    return { factors, evals, company, requests };
  })();

  // Also clear the in-tab passcode cache so the user has to re-auth.
  logInfo(
    'api',
    `POST /api/report/delete wiped ${ticker}: ${JSON.stringify(counts)}`
  );
  return sendJson(res, 200, { ticker, deleted: counts });
}

// ---------- server ----------

// ---- lists ----

function handleGetLists(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  const lists = getListsForUser(user.id).map((l) => ({
    id: l.id,
    name: l.name,
    item_count: l.item_count,
    created_at: l.created_at,
    updated_at: l.updated_at,
  }));
  return sendJson(res, 200, { lists });
}

async function handlePostList(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const name = (body.name || '').toString();
  if (!name.trim()) return sendJson(res, 400, { error: 'name is required' });
  try {
    const id = createList(user.id, name);
    logInfo('api', `POST /api/lists by ${user.email} → id=${id} name="${name.trim()}"`);
    return sendJson(res, 200, { id, name: name.trim() });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || String(err) });
  }
}

function handleGetList(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;
  const list = getListById(id, user.id);
  if (!list) return sendJson(res, 404, { error: 'List not found' });
  const items = getListItems(id).map((it) => ({
    ticker: it.ticker,
    added_at: it.added_at,
    name: it.name ?? null,
    kind: it.kind ?? null,
    profile: it.profile ?? null,
    country: it.country ?? null,
  }));
  return sendJson(res, 200, { list: { ...list, items } });
}

async function handlePatchList(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const name = (body.name || '').toString();
  if (!name.trim()) return sendJson(res, 400, { error: 'name is required' });
  try {
    const changed = updateListName(id, user.id, name);
    if (changed === 0) return sendJson(res, 404, { error: 'List not found' });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || String(err) });
  }
}

function handleDeleteListRoute(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;
  const changed = deleteList(id, user.id);
  if (changed === 0) return sendJson(res, 404, { error: 'List not found' });
  logInfo('api', `DELETE /api/lists/${id} by ${user.email}`);
  return sendJson(res, 200, { ok: true });
}

async function handlePostListItems(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const tickers = Array.isArray(body.tickers) ? body.tickers : [];
  if (tickers.length === 0) return sendJson(res, 400, { error: 'tickers must be a non-empty array' });
  const cap = getBatchSizeLimit();
  if (tickers.length > cap) {
    return sendJson(res, 400, { error: `tickers exceeds limit of ${cap}` });
  }
  try {
    const inserted = addItems(id, user.id, tickers);
    return sendJson(res, 200, { inserted });
  } catch (err) {
    return sendJson(res, 400, { error: err.message || String(err) });
  }
}

function handleDeleteListItem(req, res, id, ticker) {
  const user = requireAuth(req, res);
  if (!user) return;
  const changed = removeItem(id, user.id, ticker);
  if (changed === 0) return sendJson(res, 404, { error: 'Item not found' });
  return sendJson(res, 200, { ok: true });
}

function handleGetListExport(req, res, id) {
  const user = requireAuth(req, res);
  if (!user) return;
  const out = exportListCsv(id, user.id);
  if (!out) return sendJson(res, 404, { error: 'List not found' });
  const filename = `${out.name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'list'}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(out.csv);
}

// ---- CSV upload (auth) ----

function parseCsvText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    // First cell of a CSV row is the ticker. Trim, drop comments + empties.
    const firstCell = line.split(',')[0];
    const t = (firstCell || '').trim();
    if (!t || t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

async function handlePostEvaluateUpload(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  const limit = batchRateLimit(user.id);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return sendJson(res, 429, { error: 'Batch rate limit exceeded. Try again later.' });
  }
  let body;
  try {
    body = await readJsonBody(req, { maxBytes: 1024 * 1024 });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const csv = (body.csv || '').toString();
  if (!csv) return sendJson(res, 400, { error: 'csv is required' });
  const tickers = parseCsvText(csv);
  if (tickers.length === 0) return sendJson(res, 400, { error: 'csv had no tickers' });
  const cap = getBatchSizeLimit();
  if (tickers.length > cap) {
    return sendJson(res, 400, { error: `csv exceeds ${cap} tickers` });
  }

  let listId = null;
  if (body.listId) {
    if (!Number.isInteger(body.listId)) {
      return sendJson(res, 400, { error: 'listId must be an integer' });
    }
    const list = getListById(body.listId, user.id);
    if (!list) return sendJson(res, 404, { error: 'List not found' });
    listId = list.id;
  } else if (body.newListName) {
    try {
      listId = createList(user.id, body.newListName);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || String(err) });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const t of tickers) {
    const key = t.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  if (listId !== null) {
    try {
      addItems(listId, user.id, unique);
    } catch (err) {
      return sendJson(res, 400, { error: err.message || String(err) });
    }
  }
  const results = [];
  for (const inp of unique) {
    try {
      const r = await enqueueRequest(inp, { userId: user.id });
      results.push({
        input: inp,
        id: r.id,
        status: r.status,
        ticker: r.ticker,
        score: r.score,
        total: r.total,
      });
    } catch (err) {
      results.push({
        input: inp,
        status: 'error',
        error: err.message || String(err),
      });
    }
  }
  logInfo('api', `POST /api/evaluate/upload by ${user.email} count=${unique.length} listId=${listId}`);
  return sendJson(res, 200, { list_id: listId, results });
}

// ---- admin ----

function handleAdminGetUsers(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const rows = listUsers(200).map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    created_at: u.created_at,
  }));
  return sendJson(res, 200, { users: rows });
}

async function handleAdminPatchUserRole(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const role = (body.role || '').toString();
  if (!['user', 'admin'].includes(role)) {
    return sendJson(res, 400, { error: 'role must be user or admin' });
  }
  const target = findUserById(id);
  if (!target) return sendJson(res, 404, { error: 'User not found' });
  if (target.id === admin.id && role !== 'admin') {
    return sendJson(res, 400, { error: 'Cannot demote yourself' });
  }
  setUserRole(id, role);
  logInfo('admin', `${admin.email} set role ${target.email} → ${role}`);
  return sendJson(res, 200, { ok: true });
}

function handleAdminDeleteUser(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (id === admin.id) return sendJson(res, 400, { error: 'Cannot delete yourself' });
  const target = findUserById(id);
  if (!target) return sendJson(res, 404, { error: 'User not found' });
  deleteUser(id);
  logInfo('admin', `${admin.email} deleted user ${target.email}`);
  return sendJson(res, 200, { ok: true });
}

function handleAdminDeleteRequest(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const r = getDb().prepare(`DELETE FROM requests WHERE id = ?`).run(id);
  if (r.changes === 0) return sendJson(res, 404, { error: 'Request not found' });
  logInfo('admin', `${admin.email} deleted request #${id}`);
  return sendJson(res, 200, { ok: true });
}

function handleAdminDeleteCompany(req, res, ticker) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const r = getDb().prepare(`DELETE FROM companies WHERE ticker = ?`).run(ticker.toUpperCase());
  if (r.changes === 0) return sendJson(res, 404, { error: 'Company not found' });
  logInfo('admin', `${admin.email} deleted company ${ticker.toUpperCase()}`);
  return sendJson(res, 200, { ok: true });
}

function handleAdminDeleteEvaluation(req, res, ticker) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const db = getDb();
  const t = ticker.toUpperCase();
  const counts = db.transaction(() => {
    const factors = db.prepare(`DELETE FROM evaluation_factors WHERE ticker = ?`).run(t).changes;
    const evals = db.prepare(`DELETE FROM evaluations WHERE ticker = ?`).run(t).changes;
    const requests = db.prepare(`DELETE FROM requests WHERE ticker = ?`).run(t).changes;
    return { factors, evals, requests };
  })();
  logInfo('admin', `${admin.email} wiped evaluation ${t}: ${JSON.stringify(counts)}`);
  return sendJson(res, 200, { ticker: t, deleted: counts });
}

function handleAdminGetLists(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  return sendJson(res, 200, { lists: listAllLists(100) });
}

// ---------- server ----------

function handlePostRetry(req, res, url) {
  // URL: /api/requests/:id/retry
  const parts = url.pathname.split('/').filter(Boolean);
  // parts: ['api', 'requests', '<id>', 'retry']
  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return sendJson(res, 400, { error: 'invalid request id' });
  }
  const changed = resetErrorRequest(id);
  if (changed === 0) {
    return sendJson(res, 404, { error: 'Request not found or not in error state' });
  }
  logInfo('api', `POST /api/requests/${id}/retry → pending`);
  return sendJson(res, 200, { id, status: 'pending' });
}

function handleDismissRequest(req, res, url) {
  // URL: /api/requests/:id/dismiss — delete a single request row (used to
  // clear duplicate error cards without disturbing the matching done row).
  const parts = url.pathname.split('/').filter(Boolean);
  // parts: ['api', 'requests', '<id>', 'dismiss']
  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return sendJson(res, 400, { error: 'invalid request id' });
  }
  const changed = dismissRequest(id);
  if (changed === 0) {
    return sendJson(res, 404, { error: 'Request not found' });
  }
  logInfo('api', `POST /api/requests/${id}/dismiss → deleted`);
  return sendJson(res, 200, { id, deleted: true });
}

const server = http.createServer(async (req, res) => {
  try {
    // Parse session cookie + attach user to req before route dispatch.
    attachUser(req);

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      return serveStatic(req, res, url.pathname);
    }
    // Auth routes
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      return handleRegister(req, res, { readJsonBody, sendJson, logInfo, logWarn });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      return handleLogin(req, res, { readJsonBody, sendJson, logInfo, logWarn });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      return handleLogout(req, res, { sendJson, logInfo });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout-all') {
      return handleLogoutAll(req, res, { sendJson, logInfo });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      return handleMe(req, res, { sendJson });
    }
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      return handlePostRequest(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/requests') {
      return handleGetRequests(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/evaluate/upload') {
      return handlePostEvaluateUpload(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/best') {
      return handleGetBest(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/report') {
      return handlePostReport(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/report/preview') {
      return handlePostReportPreview(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/report/delete') {
      return handlePostDelete(req, res);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/requests/') && url.pathname.endsWith('/retry')) {
      return handlePostRetry(req, res, url);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/requests/') && url.pathname.endsWith('/dismiss')) {
      return handleDismissRequest(req, res, url);
    }
    // Lists routes
    if (req.method === 'GET' && url.pathname === '/api/lists') {
      return handleGetLists(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/lists') {
      return handlePostList(req, res);
    }
    if (url.pathname.startsWith('/api/lists/') && url.pathname.endsWith('/export')) {
      const id = Number(url.pathname.split('/')[3]);
      if (Number.isInteger(id) && id > 0) {
        return handleGetListExport(req, res, id);
      }
    }
    if (url.pathname.startsWith('/api/lists/') && url.pathname.endsWith('/items')) {
      const id = Number(url.pathname.split('/')[3]);
      if (Number.isInteger(id) && id > 0) {
        if (req.method === 'POST') return handlePostListItems(req, res, id);
      }
    }
    if (url.pathname.startsWith('/api/lists/') && url.pathname.includes('/items/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      // ['api','lists','<id>','items','<ticker>']
      const id = Number(parts[2]);
      const ticker = decodeURIComponent(parts[4] || '');
      if (req.method === 'DELETE' && Number.isInteger(id) && ticker) {
        return handleDeleteListItem(req, res, id, ticker);
      }
    }
    if (url.pathname.startsWith('/api/lists/')) {
      const id = Number(url.pathname.split('/')[3]);
      if (Number.isInteger(id) && id > 0) {
        if (req.method === 'GET') return handleGetList(req, res, id);
        if (req.method === 'PATCH') return handlePatchList(req, res, id);
        if (req.method === 'DELETE') return handleDeleteListRoute(req, res, id);
      }
    }
    // Admin routes
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      return handleAdminGetUsers(req, res);
    }
    if (url.pathname.startsWith('/api/admin/users/') && url.pathname.endsWith('/role')) {
      const id = Number(url.pathname.split('/')[4]);
      if (req.method === 'PATCH' && Number.isInteger(id)) {
        return handleAdminPatchUserRole(req, res, id);
      }
    }
    if (url.pathname.startsWith('/api/admin/users/')) {
      const id = Number(url.pathname.split('/')[4]);
      if (req.method === 'DELETE' && Number.isInteger(id)) {
        return handleAdminDeleteUser(req, res, id);
      }
    }
    if (url.pathname.startsWith('/api/admin/requests/')) {
      const id = Number(url.pathname.split('/')[4]);
      if (req.method === 'DELETE' && Number.isInteger(id)) {
        return handleAdminDeleteRequest(req, res, id);
      }
    }
    if (url.pathname.startsWith('/api/admin/companies/')) {
      const ticker = decodeURIComponent(url.pathname.split('/')[4] || '');
      if (req.method === 'DELETE' && ticker) {
        return handleAdminDeleteCompany(req, res, ticker);
      }
    }
    if (url.pathname.startsWith('/api/admin/evaluations/')) {
      const ticker = decodeURIComponent(url.pathname.split('/')[4] || '');
      if (req.method === 'DELETE' && ticker) {
        return handleAdminDeleteEvaluation(req, res, ticker);
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/lists') {
      return handleAdminGetLists(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    logError('api', `${req.method} ${req.url} threw`, err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || String(err) });
    else res.end();
  }
});

// Validate config + init db at boot so the user finds out early.
try {
  loadConfig();
} catch (err) {
  logError('boot', 'config load failed', err);
  process.exit(1);
}
try {
  initDb();
} catch (err) {
  logError('boot', 'db init failed', err);
  process.exit(1);
}
try {
  // Validate both question sets at boot so a malformed file fails fast.
  loadQuestions('company');
  loadQuestions('crypto');
} catch (err) {
  logError('boot', 'questions load failed', err);
  process.exit(1);
}

startProcessor();

server.listen(PORT, () => {
  logInfo('boot', `Stock Quality web UI: http://localhost:${PORT}`);
  logInfo('boot', `Log file: ${getLogPath()}`);
});

let shuttingDown = false;
const SHUTDOWN_GRACE_MS = 10_000;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) {
      // Second signal: don't wait, just leave.
      logWarn('boot', `${sig} received again — exiting immediately`);
      process.exit(0);
    }
    shuttingDown = true;
    logInfo(
      'boot',
      `${sig} received, shutting down (force-exit in ${SHUTDOWN_GRACE_MS / 1000}s)`
    );

    // Tell the queue to stop writing terminal status, and reset any
    // 'processing' rows to 'pending' so they retry on next start.
    try {
      const reset = beginShutdown();
      if (reset > 0) {
        logInfo('boot', `reset ${reset} in-flight request(s) to pending for retry`);
      }
    } catch (err) {
      logError('boot', 'beginShutdown failed', err);
    }

    const force = new Promise((resolve) => {
      setTimeout(() => {
        logWarn('boot', 'shutdown grace period elapsed — forcing exit');
        resolve();
      }, SHUTDOWN_GRACE_MS).unref();
    });

    const cleanup = (async () => {
      await stopProcessor();
      await new Promise((resolve) => server.close(resolve));
    })();

    await Promise.race([cleanup, force]);
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => {
  logError('uncaught', 'uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logError('uncaught', 'unhandledRejection', reason);
});