// Per-question cache layer. Each evaluation_factors row is self-keyed on
// (ticker, question_hash), so editing one question in questions.json only
// invalidates that single factor for every ticker — the other 22–23 are
// reused from cache.
//
// Cache hit semantics: a request is fully cached if every current question
// has a fresh factor (within TTL_MS) for the ticker. Otherwise the missing
// ones are sent to the LLM; the rest come from the per-question cache.

import crypto from 'node:crypto';
import { getDb, getStatements, initDb, factorsByTickerAndHashes } from './db.js';

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function questionHash(question) {
  return crypto.createHash('sha256').update(JSON.stringify(question)).digest('hex');
}

// Stable, ordered hashes for the current question set of a given kind.
export function questionHashesFor(kind, loadQuestions) {
  return loadQuestions(kind).map(questionHash);
}

// Reduce a list of factor-shaped rows to { score, total }, excluding errored
// factors from both totals. Used by saveFactors, findFreshEvaluationForQuestions,
// and the live-progress tally in the queue.
export function aggregateFactors(factors) {
  const score = factors.reduce(
    (acc, r) => acc + (r.error ? 0 : r.score === 1 ? 1 : 0),
    0
  );
  const total = factors.filter((r) => !r.error).length;
  return { score, total };
}

// Translate a cached factor row (DB shape) into the result shape consumed by
// the runner's onResult hook and the CLI/output formatters.
export function factorToResult(row) {
  return {
    index: row.idx,
    question: row.question,
    score: row.score,
    reasoning: row.reasoning || '',
    error: row.error,
  };
}

// Partition a current question list into the factors we already have cached
// for `ticker` (mapped to result shape) and the questions still missing.
// Returns { cached, missing } where `cached` is in the original question
// order via idx.
export function partitionQuestions(ticker, questions) {
  const hashes = questions.map(questionHash);
  const factors = findCachedFactors(ticker, hashes);
  const cachedByHash = new Map(factors.map((f) => [f.question_hash, f]));
  const cached = factors.map(factorToResult);
  const missing = questions
    .map((q, i) => ({ q, hash: hashes[i] }))
    .filter(({ hash }) => !cachedByHash.has(hash))
    .map(({ q }) => q);
  return { cached, missing, hashes, factors };
}

export function findCachedFactors(ticker, hashes) {
  initDb();
  if (!ticker || !Array.isArray(hashes) || hashes.length === 0) return [];
  return factorsByTickerAndHashes(ticker, hashes);
}

// True cache-hit: every current question has a cached factor AND each cached
// factor's evaluated_at is within ttlMs. Returns the aggregate { score, total,
// evaluated_at } or null. Errors don't block the hit — the factor is still
// cached — but they're excluded from score/total to match the legacy
// (pre-per-question) semantics.
export function findFreshEvaluationForQuestions(ticker, questions, { ttlMs = TTL_MS } = {}) {
  if (!ticker || !Array.isArray(questions) || questions.length === 0) return null;
  initDb();
  const now = Date.now();
  const hashes = questions.map(questionHash);
  const cached = factorsByTickerAndHashes(ticker, hashes);
  if (cached.length !== questions.length) return null;
  for (const row of cached) {
    if (!row.evaluated_at || now - row.evaluated_at > ttlMs) return null;
  }
  const { score, total } = aggregateFactors(cached);
  return {
    score,
    total,
    evaluated_at: cached.reduce((m, r) => Math.max(m, r.evaluated_at || 0), 0),
  };
}

// Persist a single factor row. Idempotent via UNIQUE(ticker, question_hash).
export function saveFactor({
  ticker,
  idx,
  question,
  score,
  reasoning,
  error,
  evaluatedAt = Date.now(),
}) {
  initDb();
  const s = getStatements();
  if (!ticker) throw new Error('saveFactor: ticker is required');
  s.upsertFactor.run({
    ticker,
    idx: typeof idx === 'number' ? idx : 0,
    question: question ?? '',
    question_hash: questionHash(question ?? ''),
    score: error ? null : score === 1 ? 1 : 0,
    reasoning: reasoning ?? null,
    error: error ?? null,
    evaluated_at: evaluatedAt,
  });
}

// Persist a batch of factors in one transaction and return aggregate stats
// for the requests row.
export function saveFactors(ticker, factors) {
  initDb();
  if (!ticker) throw new Error('saveFactors: ticker is required');
  const db = getDb();
  const now = Date.now();
  const txn = db.transaction(() => {
    for (const r of factors) {
      saveFactor({
        ticker,
        idx: r.index ?? 0,
        question: r.question ?? '',
        score: r.score,
        reasoning: r.reasoning,
        error: r.error,
        evaluatedAt: now,
      });
    }
  });
  txn();

  const { score, total } = aggregateFactors(factors);
  return { score, total, evaluated_at: now };
}

export function findCompany(ticker) {
  initDb();
  const s = getStatements();
  if (!ticker) return null;
  const row = s.findCompany.get(ticker);
  if (!row) return null;
  return {
    ticker: row.ticker,
    name: row.name,
    kind: row.kind,
    profile: row.profile,
    price: row.price,
    currency: row.currency,
    exchange: row.exchange,
    country: row.country ?? null,
    notes: row.notes,
    fetched_at: row.fetched_at,
  };
}

// Upsert the company metadata row. Called by the queue/CLI after a successful
// LLM lookup (and any Tavily enrichment) so the cached name, profile, price,
// exchange, and country stay fresh for subsequent requests.
export function saveCompany(company) {
  if (!company || !company.ticker) return;
  initDb();
  const s = getStatements();
  s.upsertCompany.run({
    ticker: company.ticker,
    name: company.name ?? null,
    kind: company.kind ?? null,
    profile: company.profile ?? null,
    price: typeof company.price === 'number' ? company.price : null,
    currency: company.currency ?? null,
    exchange: company.exchange ?? null,
    country: company.country ?? null,
    notes: company.notes ?? null,
    fetched_at: Date.now(),
  });
}