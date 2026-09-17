#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './config.js';
import {
  initDb,
  getDb,
  getStatements,
  factorsByTickerAndHashes,
  listTickersWithFactors,
} from './db.js';
import { loadQuestions } from './questions.js';
import { questionHash, findCompany } from './cache.js';
import {
  getOrGenerateOgPng,
  getOrGenerateDefaultOgPng,
  OG_WIDTH,
  OG_HEIGHT,
} from './og.js';
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
  backfillListItemsToTickers,
} from './lists.js';
import {
  findUserById,
  setUserRole,
  deleteUser,
  listUsers,
} from './users.js';
import {
  searchIndianStocks,
  loadIndianStocks,
} from './indianStocks.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve('./public');
// Public preview exposes the first N factors of a ticker's evaluation so the
// detail page can tease the analysis without a passcode. The remaining
// factors stay locked behind POST /api/report. Bump this number with care —
// every preview row is one more question's text + reasoning visible without
// authentication.
const PREVIEW_FACTOR_LIMIT = 3;

// SPA shell. Read once at boot so the server can splice a custom <head> in
// for /stock/:ticker (SEO), and so SPA fallback for unknown SPA paths is a
// constant-time send. The default head in public/index.html is the source of
// truth for both the SPA and the default server response.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

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
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

// Escape a string for safe interpolation into an HTML attribute or text node.
function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the <head>…</head> block for the SPA shell. Defaults match the head
// already in public/index.html, so serving INDEX_HTML unmodified is
// equivalent to calling this with no args. /stock/:ticker customizes the
// head with the company's name + score; everything else uses the defaults.
function buildHeadHtml({
  title = 'Investment Quality — Stock & Crypto Evaluation Dashboard',
  description = 'Evaluate any stock, crypto, IPO or idea against a 25-point business quality checklist. Public scores, no signup required to browse.',
  canonical = 'https://app.ifintok.com/',
  ogType = 'website',
  robots = 'index, follow',
  jsonLd = null,
  ogImage = 'https://app.ifintok.com/og/default.png',
  ogImageAlt = 'Investment Quality — Stock & Crypto Evaluation Dashboard',
  twitterCard = 'summary_large_image',
} = {}) {
  const t = escapeAttr(title);
  const d = escapeAttr(description);
  const c = escapeAttr(canonical);
  const r = escapeAttr(robots);
  const img = escapeAttr(ogImage);
  const imgAlt = escapeAttr(ogImageAlt);
  let head = `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${t}</title>
  <meta name="description" content="${d}" />
  <meta name="robots" content="${r}" />
  <meta name="theme-color" content="#2563eb" />
  <link rel="canonical" href="${c}" />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiMyNTYzZWIiLz48dGV4dCB4PSIzMiIgeT0iNDQiIGZvbnQtc2l6ZT0iMzgiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IndoaXRlIiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC13ZWlnaHQ9IjcwMCI+SVE8L3RleHQ+PC9zdmc+" />

  <meta property="og:type" content="${ogType}" />
  <meta property="og:site_name" content="Investment Quality" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:url" content="${c}" />
  <meta property="og:image" content="${img}" />
  <meta property="og:image:width" content="${OG_WIDTH}" />
  <meta property="og:image:height" content="${OG_HEIGHT}" />
  <meta property="og:image:alt" content="${imgAlt}" />

  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${img}" />
  <meta name="twitter:image:alt" content="${imgAlt}" />`;

  head += `\n  <link rel="stylesheet" href="/styles.css" />`;
  if (jsonLd) {
    head += `\n  <script type="application/ld+json">\n  ${JSON.stringify(jsonLd, null, 2)}\n  </script>`;
  }

  head += `\n</head>`;
  return head;
}

// Heuristic for "looks like a static asset path": last segment has a file
// extension (e.g. /foo.css, /img/x.png). Distinguishes real "not found"s
// from SPA paths like /lists/123 that don't have an on-disk counterpart.
function looksLikeAssetPath(p) {
  const last = p.split('/').pop() || '';
  return /\.[a-zA-Z0-9]+$/.test(last);
}

// Styled HTML 404 page returned to crawlers + users for missing assets.
function sendHtml404(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Page not found — Investment Quality</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#2563eb" />
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f7f7f8;
      color: #111827;
      line-height: 1.5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .error-card {
      text-align: center;
      padding: 40px 32px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      max-width: 420px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 24px; color: #6b7280; font-size: 14px; }
    a {
      display: inline-block;
      padding: 10px 20px;
      background: #2563eb;
      color: white;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 500;
      font-size: 15px;
    }
    a:hover { background: #1d4ed8; }
    .brand { font-size: 12px; color: #9ca3af; margin-top: 24px; letter-spacing: 0.04em; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="error-card">
    <h1>404 — Page not found</h1>
    <p>The page you're looking for doesn't exist or has been moved.</p>
    <a href="/">Back to dashboard</a>
    <div class="brand">Investment Quality</div>
  </div>
</body>
</html>`;
  send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, html);
}

// Serve either a static asset (200 on hit, HTML 404 on miss) or the SPA
// shell (200, always — let the client router decide what to render). The
// /stock/:ticker handler runs before this so it can splice a custom head.
function serveSpaOrStatic(req, res, urlPath) {
  if (looksLikeAssetPath(urlPath)) {
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const abs = path.join(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR)) {
      return sendHtml404(res);
    }
    fs.readFile(abs, (err, data) => {
      if (err) return sendHtml404(res);
      send(res, 200, { 'Content-Type': contentTypeFor(abs) }, data);
    });
    return;
  }
  // SPA fallback: every non-asset path serves the shell; the client router
  // renders renderNotFound() for unknown pathnames.
  send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, INDEX_HTML);
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
  // Anon: see public recent (requests where user_id IS NULL — anonymous
  // activity + legacy rows from before auth existed). Logged-in users see
  // their own filtered list below; admin sees everything.
  if (!req.user) {
    const ongoing = getOngoingPublic(RECENT_LIMIT).map(shapeRequestRow);
    const errors = getRecentErrorsPublic(ERROR_LIMIT).map(shapeRequestRow);
    return sendJson(res, 200, { requests: ongoing, errors, paused: isPaused() });
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

// Public recent: requests with user_id IS NULL — anonymous activity submitted
// without a session + legacy rows from before the user_id column existed.
// Mirrors the column set returned by getOngoingFor so shapeRequestRow works
// the same way for anon.
function getOngoingPublic(limit) {
  initDb();
  const db = getDb();
  return db.prepare(`
    SELECT r.*,
           c.name AS company_name, c.kind AS company_kind, c.profile AS company_profile,
           c.country AS company_country,
           (SELECT MAX(evaluated_at) FROM evaluation_factors WHERE ticker = r.ticker) AS evaluated_at
    FROM requests r
    LEFT JOIN companies c ON c.ticker = r.ticker
    WHERE r.user_id IS NULL
      AND r.status IN ('pending','processing','done')
    ORDER BY r.updated_at DESC
    LIMIT ?
  `).all(limit);
}

function getRecentErrorsPublic(limit) {
  initDb();
  const db = getDb();
  return db.prepare(`
    SELECT * FROM requests
    WHERE status = 'error' AND user_id IS NULL
    ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
}

function handleGetBest(req, res) {
  // Per-question caching means "complete evaluation" is determined by the
  // count of distinct cached factors matching the current question set for
  // the ticker's kind. Pass the two kind counts into the best-of query.
  const rows = getBest(20, kindCounts()).map((r) => ({
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

// Public — no auth. Returns up to 20 NSE tickers (main board + SME) whose
// ticker or name contains the query (case-insensitive, all tokens must match).
// Drives the home-form combobox. Pure in-memory — no DB hit.
function handleGetStocks(req, res, url) {
  const q = url.searchParams.get('q') || '';
  const limitRaw = Number(url.searchParams.get('limit') || 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
  const matches = searchIndianStocks(q, limit);
  return sendJson(res, 200, { stocks: matches });
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

// Server-rendered head for /stock/:ticker. Looks up the company + score and
// splices a custom <head> into the SPA shell so crawlers and link previews
// see meaningful meta without executing JS. If the ticker is unknown (no
// metadata, no factors), falls back to the generic shell + the SPA's
// "No recent activity" empty state.
async function handleGetStockPage(req, res, ticker) {
  const company = findCompany(ticker);
  const kind = company?.kind || 'listed';
  const hashes = loadQuestions(kind).map(questionHash);
  const rows = factorsByTickerAndHashes(ticker, hashes);
  const score = rows.filter((r) => !r.error && r.score === 1).length;
  const total = rows.filter((r) => !r.error).length;
  const hasFactors = total > 0;

  const canonical = `https://app.ifintok.com/stock/${ticker}`;
  // Always point at the per-ticker image. The handler at /og/<TICKER>.png
  // falls back to /og/default.png server-side when there's no company or
  // no factors yet — keeps the URL consistent and lets the SPA update the
  // same og:image URL on client-side navigation.
  const ogImage = `https://app.ifintok.com/og/${ticker}.png`;
  let title;
  let description;
  let ogImageAlt;
  let jsonLd = null;

  if (company && hasFactors) {
    const name = company.name;
    title = `${ticker} — ${name} Quality Report | Investment Quality`;
    description = `${name} (${ticker}) scored ${score}/${total} on the Investment Quality checklist. View the full breakdown of business quality factors.`;
    ogImageAlt = `${name} (${ticker}) scored ${score}/${total} on the Investment Quality checklist`;
    jsonLd =
      kind === 'crypto'
        ? {
            '@context': 'https://schema.org',
            '@type': 'FinancialProduct',
            name,
            identifier: ticker,
            url: canonical,
          }
        : {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name,
            tickerSymbol: ticker,
            url: canonical,
          };
  } else if (company) {
    const name = company.name;
    title = `${ticker} — ${name} | Investment Quality`;
    description = `${name} (${ticker}). Submit from the dashboard to see the full business quality breakdown.`;
    ogImageAlt = `${name} (${ticker}) — Investment Quality`;
  } else {
    title = `${ticker} — Investment Quality`;
    description = `${ticker} quality evaluation. Submit from the dashboard to see the full breakdown of business quality factors.`;
    ogImageAlt = `${ticker} — Investment Quality`;
  }

  const head = buildHeadHtml({ title, description, canonical, jsonLd, ogImage, ogImageAlt });
  const html = INDEX_HTML.replace(/<head>[\s\S]*?<\/head>/, head);
  send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
}

// Dynamic sitemap. Lists the homepage plus every ticker with at least one
// cached factor. lastmod is the max(evaluated_at) for that ticker, formatted
// as YYYY-MM-DD. Cheap enough to rebuild per request — no cache layer.
function handleGetSitemap(req, res) {
  const tickers = listTickersWithFactors();
  const base = 'https://app.ifintok.com';
  const entries = [
    { loc: `${base}/`, changefreq: 'hourly' },
    ...tickers.map((t) => ({
      loc: `${base}/stock/${t.ticker}`,
      lastmod: t.last_evaluated_at
        ? new Date(t.last_evaluated_at).toISOString().slice(0, 10)
        : null,
      changefreq: 'weekly',
    })),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map((u) => {
    let s = `  <url>\n    <loc>${u.loc}</loc>`;
    if (u.lastmod) s += `\n    <lastmod>${u.lastmod}</lastmod>`;
    s += `\n    <changefreq>${u.changefreq}</changefreq>\n  </url>`;
    return s;
  })
  .join('\n')}
</urlset>`;
  send(res, 200, { 'Content-Type': 'application/xml; charset=utf-8' }, body);
}

// Serve a 1200x630 PNG for use as og:image / twitter:image. Two paths:
//   /og/default.png  — generic branded card (used by dashboard + 404 +
//                      stock pages with no evaluation yet). Cached forever.
//   /og/<TICKER>.png — per-stock card with ticker, company name, score,
//                      country, evaluated date. Lazy-generated on first
//                      crawler hit; the queue also refreshes eagerly after
//                      every successful evaluation.
// On miss for a ticker with no company metadata, falls back to default.png
// (decision: missing tickers always show the generic image so we don't
// burn CPU on share-bait typos).
async function handleGetOgImage(req, res, url) {
  // /og/default.png
  if (url.pathname === '/og/default.png') {
    const { png } = await getOrGenerateDefaultOgPng();
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    return res.end(png);
  }

  // /og/<TICKER>.png
  const tickerMatch = url.pathname.match(/^\/og\/([A-Za-z0-9.\-_]+)\.png$/);
  if (!tickerMatch) return sendHtml404(res);
  const ticker = tickerMatch[1].toUpperCase();

  initDb();
  const company = findCompany(ticker);
  if (!company) {
    // No metadata — serve default.png instead of generating a ticker-only
    // card. Avoids caching N placeholder images for share-bait URLs.
    const { png } = await getOrGenerateDefaultOgPng();
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(png);
  }

  const kind = company.kind || 'listed';
  const hashes = loadQuestions(kind).map(questionHash);
  const rows = factorsByTickerAndHashes(ticker, hashes);
  const total = rows.filter((r) => !r.error).length;
  const score = rows.filter((r) => !r.error && r.score === 1).length;
  const evaluatedAt = rows.reduce((m, r) => Math.max(m, r.evaluated_at || 0), 0);

  const { png } = await getOrGenerateOgPng(ticker, {
    company,
    score: total > 0 ? score : null,
    total: total > 0 ? total : null,
    evaluatedAt,
  });
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(png);
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
    ticker: it.resolved_ticker ?? it.ticker,
    raw_ticker: it.ticker,
    added_at: it.added_at,
    name: it.name ?? null,
    kind: it.kind ?? null,
    profile: it.profile ?? null,
    country: it.country ?? null,
    score: it.score ?? null,
    total: it.total ?? null,
    evaluated_at: it.evaluated_at ?? null,
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

    if (req.method === 'GET' || req.method === 'HEAD') {
      // Stock detail page: server-rendered <head> for SEO + link previews.
      // Pattern matches /stock/<TICKER> with URL-safe chars; ticker is
      // uppercased before lookup so /stock/aapl works too.
      const stockMatch = url.pathname.match(/^\/stock\/([A-Za-z0-9.\-_]+)$/);
      if (stockMatch) {
        return handleGetStockPage(req, res, stockMatch[1].toUpperCase());
      }
      // Dynamic sitemap.xml (needs DB lookup, so not a static file).
      if (url.pathname === '/sitemap.xml') {
        return handleGetSitemap(req, res);
      }
      // Open Graph images (/og/default.png + /og/<TICKER>.png). These have
      // .png extensions so serveSpaOrStatic would treat them as missing
      // assets and return 404 HTML — intercept them here first.
      // Also accept HEAD so pre-flight crawlers get headers without body.
      if (url.pathname.startsWith('/og/')) {
        return handleGetOgImage(req, res, url);
      }
    }
    // Everything else under GET that isn't /api/*: SPA fallback for unknown
    // paths, real static files for asset paths, HTML 404 for missing assets.
    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      return serveSpaOrStatic(req, res, url.pathname);
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
    if (req.method === 'GET' && url.pathname === '/api/stocks') {
      return handleGetStocks(req, res, url);
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
  // One-time backfill: convert name-stored list_items rows to their resolved
  // ticker so PRIMARY KEY (list_id, ticker) enforces uniqueness going forward.
  const changed = backfillListItemsToTickers();
  if (changed > 0) {
    logInfo('boot', `backfilled ${changed} list_items rows from raw input to ticker`);
  }
} catch (err) {
  logWarn('boot', `list_items backfill failed (non-fatal): ${err.message || err}`);
}
try {
  // Validate both question sets at boot so a malformed file fails fast.
  loadQuestions('company');
  loadQuestions('crypto');
} catch (err) {
  logError('boot', 'questions load failed', err);
  process.exit(1);
}

// Load the NSE ticker index so /api/stocks and the queue's fast-path are
// ready immediately. loadIndianStocks() never throws — a missing CSV is
// surfaced as a warning but doesn't block boot.
try {
  const status = loadIndianStocks();
  logInfo('boot', `NSE ticker index loaded: ${status.count} entries${status.error ? ` (warn: ${status.error})` : ''}`);
} catch (err) {
  logWarn('boot', `NSE index load failed (non-fatal): ${err.message || err}`);
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