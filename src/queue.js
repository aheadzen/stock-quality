// Background request queue. Persists requests in SQLite, processes them with a
// capped number of concurrent *requests* (each request internally still runs
// its 23 questions with p-limit from settings inside runEvaluations).
//
// Per-question cache: before calling the LLM, check which questions already
// have a fresh factor cached for this ticker. Only the missing ones are sent
// to the model. The aggregator below combines cached + fresh results when
// writing the requests row.
//
// On a 429 from any underlying call, we mark the current request as 'error',
// set an in-memory `pausedUntil`, and the loop sleeps until then. The pause
// state is in-memory only — process restarts wipe it. That's intentional:
// stuck pauses shouldn't outlive the process.

import { initDb, getDb, getStatements } from './db.js';
import { getClient } from './client.js';
import { loadQuestions } from './questions.js';
import { lookupCompany, lookupCachedCompany, enrichCompanyWithTavily } from './company.js';
import { runEvaluations } from './runner.js';
import {
  findCachedFactors,
  findFreshEvaluationForQuestions,
  partitionQuestions,
  aggregateFactors,
  saveCompany,
  saveFactor,
  saveFactors,
} from './cache.js';
import { RateLimitError } from './evaluator.js';
import { logError, logWarn, logInfo, getLogPath } from './logger.js';
import { getConcurrency } from './settings.js';

const PAUSE_MS = 60 * 60 * 1000; // 1 hour backoff after a 429
const TICK_MS = 500; // idle poll interval

let processorRunning = false;
let pausedUntil = 0;
let processorPromise = null;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enqueue a new request for `input`. If we can resolve a cached company AND
// every current question has a fresh factor for it, the request is inserted
// as already done. Otherwise it's pending and the processor will pick it up.
export async function enqueueRequest(input) {
  initDb();
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('input is required');

  const client = getClient();

  // Best-effort quick lookup. If it fails (no cache hit, or LLM error),
  // fall through to pending and let the processor handle it.
  let company = await lookupCachedCompany(trimmed);
  if (!company) {
    try {
      company = await lookupCompany(client, trimmed);
    } catch (err) {
      // Couldn't resolve — still record the request as pending. The
      // processor will retry the lookup when it picks the row up.
      company = null;
    }
  }

  // Pick questions based on entity kind (crypto vs company). Default to
  // company if kind is unknown — the processor will retry with the right
  // kind once it resolves the company.
  const kind = company?.kind || 'listed';
  const questions = loadQuestions(kind);

  const ticker = company?.ticker || null;
  const cached = ticker ? findFreshEvaluationForQuestions(ticker, questions) : null;

  if (cached) {
    // Even on a full cache hit, persist the company metadata — `lookupCompany`
    // ran above and may have refreshed a stale or missing `companies` row.
    // Without this, an orphan ticker (factors cached, no company row) stays
    // orphaned forever and the UI falls back to the raw user input as the name.
    if (company) saveCompany(company);
    const id = recordCompletedRequest(trimmed, ticker, cached.score, cached.total);
    return {
      id,
      status: 'done',
      ticker,
      score: cached.score,
      total: cached.total,
    };
  }

  const now = Date.now();
  const id = getStatements().insertRequest.run({
    input: trimmed,
    ticker,
    status: 'pending',
    score: null,
    total: null,
    created_at: now,
    updated_at: now,
  }).lastInsertRowid;

  return { id: Number(id), status: 'pending', ticker };
}

async function processRequest(req, client, settings) {
  const s = getStatements();
  const now = Date.now();

  // Mark as processing. If another worker already grabbed it, bail.
  const claimed = s.markRequestProcessing.run(now, req.id);
  if (claimed.changes === 0) return;

  let company = await lookupCachedCompany(req.input);
  if (!company) {
    try {
      company = await lookupCompany(client, req.input);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // If we're shutting down, leave the row in 'pending' so it retries
      // on the next start. Don't mark it 'error'.
      if (shuttingDown) return;
      return fail(req.id, `Company lookup failed: ${err.message || err}`);
    }
  }

  // Fallback: if the LLM couldn't resolve ticker or price (common for
  // companies whose listing is past its training cutoff), try Tavily.
  // Also runs when the LLM mis-classified as 'unlisted' — if Tavily finds a
  // real ticker, the enrichment upgrades kind to 'listed' automatically.
  // Best-effort: any error here is swallowed and the original (possibly
  // partial) company is kept.
  if (company && (!company.ticker || company.price == null)) {
    try {
      company = await enrichCompanyWithTavily(client, req.input, company);
    } catch (err) {
      logWarn(
        'queue',
        `Tavily enrichment failed for "${req.input}": ${err.message || err}`
      );
    }
  }

  if (!company?.ticker) {
    if (shuttingDown) return;
    return fail(req.id, `Could not resolve a ticker for "${req.input}".`);
  }

  // Update the request row with the resolved ticker so getBest can join.
  getDb().prepare(`UPDATE requests SET ticker = ?, updated_at = ? WHERE id = ?`)
    .run(company.ticker, Date.now(), req.id);

  // Pick the question set that matches the entity kind. This is the key
  // per-request decision — company questions vs crypto questions.
  const questions = loadQuestions(company.kind);

  // Per-question cache check after lookup. A recent eval may exist for the
  // resolved ticker against SOME of the current questions. We partition
  // into cached (reuse) and missing (send to LLM).
  const { cached: cachedResults, missing } = partitionQuestions(
    company.ticker,
    questions
  );

  // Build the seed partial-tally from cached factors so the live-progress UI
  // shows the right numbers as the missing questions complete.
  const partial = cachedResults.slice();
  const pushProgress = () => {
    const { score: liveScore, total: liveTotal } = aggregateFactors(partial);
    s.updateRequestProgress.run(liveScore, liveTotal, Date.now(), req.id);
  };

  if (missing.length === 0) {
    const { score, total } = aggregateFactors(cachedResults);
    // Persist the (possibly fresh) company metadata even on a full cache hit.
    saveCompany(company);
    s.completeRequest.run(score, total, Date.now(), Date.now(), req.id);
    logInfo(
      'queue',
      `request #${req.id} (${req.input}) cache hit: ${score}/${total} (${cachedResults.length} factors reused)`
    );
    return;
  }

  logInfo(
    'queue',
    `request #${req.id} (${req.input}) evaluating ${missing.length}/${questions.length} question(s) (${cachedResults.length} cached)`
  );

  let results;
  try {
    results = await runEvaluations(client, missing, company, {
      concurrency: settings.questions,
      onResult: (r) => {
        try {
          saveFactor({
            ticker: company.ticker,
            idx: r.index,
            question: r.question,
            score: r.score,
            reasoning: r.reasoning,
            error: r.error,
          });
        } catch {
          /* never let a cache write kill the run */
        }
        partial.push(r);
        try { pushProgress(); } catch { /* never let a UI write kill the run */ }
      },
    });
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (shuttingDown) return;
    return fail(req.id, err.message || String(err));
  }

  const saved = saveFactors(company.ticker, results);
  // Persist company metadata so future requests see fresh name/price/country
  // even when the cache-hit path is taken and the LLM is never invoked.
  saveCompany(company);

  s.completeRequest.run(saved.score, saved.total, Date.now(), Date.now(), req.id);
  logInfo(
    'queue',
    `request #${req.id} (${req.input}) done: ${saved.score}/${saved.total}`
  );
}

function fail(id, message) {
  const s = getStatements();
  const now = Date.now();
  s.failRequestError.run(message, now, now, id);
  logWarn('queue', `request #${id} failed: ${message}`);
}

async function tick(client, settings) {
  // Honor the 429 backoff.
  if (pausedUntil > Date.now()) {
    await sleep(Math.min(TICK_MS * 4, pausedUntil - Date.now()));
    return;
  }

  const s = getStatements();
  // JS is single-threaded so we don't need transactional FOR UPDATE: any row
  // we claim via markRequestProcessing can't be touched by another tick until
  // we yield. Keep the LIMIT at stockSearch concurrency for the upper bound.
  const pending = s.listPending.all(settings.stockSearch);
  if (pending.length === 0) {
    await sleep(TICK_MS);
    return;
  }

  // Run the batch concurrently. Any 429 anywhere pauses the whole pipeline.
  await Promise.all(
    pending.map((req) =>
      processRequest(req, client, settings).catch(async (err) => {
        if (err instanceof RateLimitError) {
          pausedUntil = Date.now() + PAUSE_MS;
          logError(
            'queue',
            `request #${req.id} (${req.input}) hit rate limit; pausing pipeline for 1 hour`,
            err
          );
          fail(
            req.id,
            `Rate limited (429). Pausing for 1 hour. ${err.message || ''}`
          );
        } else {
          logError(
            'queue',
            `request #${req.id} (${req.input}) threw in processRequest`,
            err
          );
          fail(req.id, err.message || String(err));
        }
      })
    )
  );
}

export function startProcessor() {
  if (processorRunning) return;
  processorRunning = true;
  shuttingDown = false; // fresh boot — clear any flag from a prior lifetime
  initDb();

  // Reset any rows left in 'processing' from a previous crash so they get retried.
  const s = getStatements();
  s.resetProcessingToPending.run(Date.now());

  let client;
  try {
    client = getClient();
  } catch (err) {
    logError('queue', 'client init failed', err);
    processorRunning = false;
    return;
  }

  const settings = getConcurrency();

  logInfo(
    'queue',
    `processor started; questions=${settings.questions} stockSearch=${settings.stockSearch}`
  );

  processorPromise = (async () => {
    while (processorRunning) {
      try {
        await tick(client, settings);
      } catch (err) {
        logError('queue', 'tick loop error', err);
        await sleep(TICK_MS);
      }
    }
  })();
}

export function stopProcessor() {
  processorRunning = false;
  return processorPromise ?? Promise.resolve();
}

// Mark shutdown in progress. Resets any in-flight 'processing' rows back to
// 'pending' so they'll be retried on the next start, and prevents
// processRequest from writing terminal 'error' status when in-flight LLM
// calls return failures during the shutdown window.
export function beginShutdown() {
  if (shuttingDown) return 0;
  shuttingDown = true;
  const s = getStatements();
  const res = s.resetProcessingToPending.run(Date.now());
  return res.changes;
}

export function isShuttingDown() {
  return shuttingDown;
}

export function isPaused() {
  return pausedUntil > Date.now();
}

// --- read APIs used by the HTTP server ---

export function getOngoing(limit = 5) {
  initDb();
  const s = getStatements();
  // Returns the most recently updated of pending/processing/done. Ordered by
  // updated_at DESC so freshly completed items bubble to the top alongside
  // still-pending work.
  return s.listOngoing.all(limit);
}

export function getRecentErrors(limit = 5) {
  initDb();
  const s = getStatements();
  return s.listRecentErrors.all(limit);
}

export function getAllRequests(limit = 50) {
  initDb();
  const s = getStatements();
  return s.listRequestsAll.all(limit);
}

// `kindCounts` is an array of two integers: the expected question counts for
// (company, crypto). A ticker is "complete" against its kind when it has at
// least `kindCounts[kindIndex]` distinct cached factors. The SQL reads
// placeholders in the order (crypto, company), so we pass them in that order.
export function getBest(limit = 5, kindCounts) {
  initDb();
  const s = getStatements();
  if (!Array.isArray(kindCounts) || kindCounts.length !== 2) return [];
  const [companyCount, cryptoCount] = kindCounts;
  return s.bestByKindCounts.all(cryptoCount, companyCount, limit);
}

// Persist a 'done' row for an evaluation that completed outside the queue
// (e.g. from the CLI). The row is what surfaces in the web UI's recent list
// and in the best-of list.
export function recordCompletedRequest(input, ticker, score, total) {
  initDb();
  const s = getStatements();
  const now = Date.now();
  const id = s.insertRequest.run({
    input: input || '',
    ticker: ticker || null,
    status: 'done',
    score: typeof score === 'number' ? score : null,
    total: typeof total === 'number' ? total : null,
    created_at: now,
    updated_at: now,
  }).lastInsertRowid;
  return Number(id);
}

// Flip an 'error' row back to 'pending' so the operator can retry without
// re-typing the input and without leaving a duplicate row in the table.
// Returns the number of rows updated (0 if the id wasn't found or wasn't
// in an error state).
export function resetErrorRequest(id) {
  initDb();
  const now = Date.now();
  const db = getDb();
  return db
    .prepare(
      `UPDATE requests
       SET status='pending', score=NULL, total=NULL, error_message=NULL, updated_at=?
       WHERE id=? AND status='error'`
    )
    .run(now, id).changes;
}

// Dismiss a single request row by id — used to clean up duplicate error
// cards without touching the matching done row for the same ticker.
// Returns 1 if deleted, 0 if not found.
export function dismissRequest(id) {
  initDb();
  const db = getDb();
  return db.prepare(`DELETE FROM requests WHERE id = ?`).run(id).changes;
}