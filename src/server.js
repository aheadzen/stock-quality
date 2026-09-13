#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './config.js';
import { initDb, getStatements, factorsByTickerAndHashes } from './db.js';
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
  const input = (body.input || '').toString().trim();
  if (!input) return sendJson(res, 400, { error: 'input is required' });
  try {
    const result = await enqueueRequest(input);
    logInfo('api', `POST /api/requests input="${input}" → ${result.status}${result.status === 'done' ? ` (${result.score}/${result.total})` : ''}`);
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
  if (status === 'errors') {
    const rows = getRecentErrors(ERROR_LIMIT).map(shapeRequestRow);
    return sendJson(res, 200, { requests: rows, paused: isPaused() });
  }
  // default (and ?status=ongoing): pending + processing + recent errors,
  // so the operator always sees what just blew up.
  const ongoing = getOngoing(RECENT_LIMIT).map(shapeRequestRow);
  const errors = getRecentErrors(ERROR_LIMIT).map(shapeRequestRow);
  return sendJson(res, 200, {
    requests: ongoing,
    errors,
    paused: isPaused(),
  });
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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      return serveStatic(req, res, url.pathname);
    }
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      return handlePostRequest(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/requests') {
      return handleGetRequests(req, res, url);
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