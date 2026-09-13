// Cache layer: 90-day TTL on (ticker, questions_hash). Persists company metadata
// and the full per-question evaluation so we can re-score without burning API calls.

import crypto from 'node:crypto';
import { getDb, getStatements, initDb } from './db.js';

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function questionsHash(questions) {
  const json = JSON.stringify(questions);
  return crypto.createHash('sha256').update(json).digest('hex');
}

export function findFreshEvaluation(ticker, questionsHashValue) {
  initDb();
  const s = getStatements();
  if (!ticker) return null;
  const now = Date.now();
  const row = s.findFreshEvaluation.get(ticker, questionsHashValue, now);
  if (!row) return null;
  return {
    score: row.score,
    total: row.total,
    evaluated_at: row.evaluated_at,
    expires_at: row.expires_at,
  };
}

// Persist company + evaluation + factors in a single transaction. Idempotent
// via UNIQUE(ticker, questions_hash): re-saving the same pair updates in place.
export function saveEvaluation({ ticker, company, results, questionsHashValue }) {
  initDb();
  const db = getDb();
  const s = getStatements();

  const now = Date.now();
  const expiresAt = now + TTL_MS;

  const score = results.reduce(
    (acc, r) => acc + (r.error ? 0 : r.score === 1 ? 1 : 0),
    0
  );
  const total = results.filter((r) => !r.error).length;

  const txn = db.transaction(() => {
    if (ticker) {
      s.upsertCompany.run({
        ticker,
        name: company?.name ?? null,
        kind: company?.kind ?? null,
        profile: company?.profile ?? null,
        price: typeof company?.price === 'number' ? company.price : null,
        currency: company?.currency ?? null,
        exchange: company?.exchange ?? null,
        notes: company?.notes ?? null,
        fetched_at: now,
      });
    }

    s.insertEvaluation.run({
      ticker: ticker ?? '',
      questions_hash: questionsHashValue,
      score,
      total,
      evaluated_at: now,
      expires_at: expiresAt,
    });

    const evalRow = s.findEvaluationAny.get(ticker ?? '', questionsHashValue);
    if (evalRow?.id) {
      s.deleteFactorsForEvaluation.run(evalRow.id);
      const insertFact = s.insertFactor;
      for (const r of results) {
        insertFact.run({
          evaluation_id: evalRow.id,
          idx: r.index ?? 0,
          question: r.question ?? '',
          score: r.error ? null : r.score === 1 ? 1 : 0,
          reasoning: r.reasoning ?? null,
          error: r.error ?? null,
        });
      }
    }
  });

  txn();
  return { score, total, evaluated_at: now, expires_at: expiresAt };
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
    notes: row.notes,
    fetched_at: row.fetched_at,
  };
}