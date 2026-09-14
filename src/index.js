#!/usr/bin/env node
// CLI entrypoint. Two modes:
//
//   1. Legacy single-stock (no env vars). Reads from argv[2] or stdin,
//      resolves the company inline, calls the LLM, prints summary. No HTTP.
//   2. Authenticated batch (STOCK_QUALITY_EMAIL + STOCK_QUALITY_PASSWORD set).
//      Reads N tickers from argv / --file, logs in via HTTP, POSTs them to
//      /api/requests as { inputs: [...] }, and reports each per-ticker
//      status. Falls back to the single-stock inline path if the server is
//      unreachable.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getClient } from './client.js';
import { loadQuestions } from './questions.js';
import { resolveInput } from './input.js';
import { lookupCompany, lookupCachedCompany } from './company.js';
import { runEvaluations } from './runner.js';
import { initDb } from './db.js';
import {
  aggregateFactors,
  findFreshEvaluationForQuestions,
  partitionQuestions,
  saveCompany,
  saveFactor,
  saveFactors,
} from './cache.js';
import { recordCompletedRequest } from './queue.js';
import { printSummary, printVerbose } from './output.js';
import { logError, logInfo, getLogPath } from './logger.js';
import { getConcurrency, getConfigPath } from './settings.js';

const VERBOSE = process.argv.includes('--verbose');
const CLI_BATCH_LIMIT = 100;

function parseFlag(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

// Returns the positionals (non-flags) from argv, skipping the value
// following any flag that takes one.
function parsePositionals() {
  const takeVal = new Set(['--file', '--user-email', '--user-password']);
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--verbose') continue;
    if (takeVal.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

// Read tickers from a flag, file, or stdin. Splits on commas + newlines,
// trims, dedupes (case-insensitive), drops empties, caps at CLI_BATCH_LIMIT.
async function readInputs() {
  const filePath = parseFlag('--file');
  if (filePath) {
    const abs = path.resolve(filePath);
    const text = await fs.promises.readFile(abs, 'utf8');
    return dedupe(text.split(/[\n,]+/));
  }
  const positional = parsePositionals();
  if (positional.length > 0) {
    const joined = positional.join('\n');
    return dedupe(joined.split(/[\n,]+/));
  }
  // Fall back to interactive single prompt for the legacy single-stock path.
  const single = await resolveInput();
  return dedupe([single]);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const v = (raw || '').toString().trim();
    if (!v) continue;
    const key = v.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= CLI_BATCH_LIMIT) break;
  }
  return out;
}

async function tryHttpBatch({ email, password, port, inputs }) {
  // Use 127.0.0.1 by default; production deployments may set PORT in env.
  const base = `http://127.0.0.1:${port}`;
  // Step 1: log in
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    return { ok: false, reason: `login failed: HTTP ${loginRes.status}` };
  }
  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) return { ok: false, reason: 'no session cookie returned' };
  const cookie = setCookie.split(';')[0];
  // Step 2: submit the batch
  const submitRes = await fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ inputs }),
  });
  if (!submitRes.ok) {
    let msg = `HTTP ${submitRes.status}`;
    try {
      const j = await submitRes.json();
      if (j.error) msg = j.error;
    } catch { /* ignore */ }
    return { ok: false, reason: msg };
  }
  const j = await submitRes.json();
  return { ok: true, results: j.results || [] };
}

async function inlineSingle(input) {
  const client = getClient();
  logInfo('cli', `lookup start: input="${input}"`);
  let company = await lookupCachedCompany(input);
  if (!company) {
    try {
      company = await lookupCompany(client, input);
    } catch (err) {
      logError('cli', `company lookup failed for "${input}"`, err);
      return null;
    }
  } else {
    process.stderr.write(`(company metadata from cache)\n`);
  }
  if (!company) {
    process.stderr.write(
      `Could not resolve a ticker for "${input}". Only listed/IPO/crypto entities can be scored.\n`
    );
    return null;
  }
  process.stderr.write(
    `Company: ${company.name} (${company.ticker}) — ${company.price ?? 'n/a'} ${company.currency ?? ''}\n`
  );
  let questions;
  try {
    questions = loadQuestions(company.kind);
  } catch (err) {
    logError('cli', `questions load failed for kind=${company.kind}`, err);
    return null;
  }
  const cached = findFreshEvaluationForQuestions(company.ticker, questions);
  if (cached) {
    process.stderr.write(
      `Cache hit (within 90 days). Score: ${cached.score} / ${cached.total}\n`
    );
    saveCompany(company);
    recordCompletedRequest(input, company.ticker, cached.score, cached.total);
    const { cached: cachedResults } = partitionQuestions(company.ticker, questions);
    printSummary(company, cachedResults, { source: 'cache' });
    if (VERBOSE) printVerbose(company, cachedResults);
    return { score: cached.score, total: cached.total, cached: true };
  }
  const { cached: cachedResults, missing } = partitionQuestions(
    company.ticker,
    questions
  );
  const { questions: QUESTION_CONCURRENCY } = getConcurrency();
  process.stderr.write(
    `Evaluating ${missing.length}/${questions.length} question${questions.length === 1 ? '' : 's'} (${cachedResults.length} cached, concurrency ${QUESTION_CONCURRENCY})...\n`
  );
  let results;
  try {
    results = await runEvaluations(client, missing, company, {
      concurrency: QUESTION_CONCURRENCY,
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
        } catch { /* never let a cache write kill the run */ }
      },
    });
  } catch (err) {
    logError('cli', `runEvaluations failed for "${input}"`, err);
    return null;
  }
  saveFactors(company.ticker, results);
  saveCompany(company);
  const { score, total } = aggregateFactors(results);
  recordCompletedRequest(input, company.ticker, score, total);
  const merged = [...cachedResults, ...results].sort((a, b) => a.index - b.index);
  printSummary(company, merged, { source: 'fresh' });
  if (VERBOSE) printVerbose(company, merged);
  return { score, total, cached: false };
}

async function main() {
  try {
    loadConfig();
  } catch (err) {
    logError('cli', 'config load failed', err);
    process.exit(1);
  }
  try {
    initDb();
  } catch (err) {
    logError('cli', 'db init failed', err);
    process.exit(1);
  }
  logInfo('cli', `Log file: ${getLogPath()}`);
  logInfo('cli', `Config: ${getConfigPath()}`);

  const inputs = await readInputs();
  if (inputs.length === 0) {
    process.stderr.write('No tickers provided.\n');
    process.exit(2);
  }

  // Multi-ticker: try HTTP batch with env-var credentials. Fall through to
  // inline single-stock when the server isn't reachable.
  const email = process.env.STOCK_QUALITY_EMAIL;
  const password = process.env.STOCK_QUALITY_PASSWORD;
  if (email && password && inputs.length > 0) {
    const port = Number(process.env.PORT || 3000);
    let res;
    try {
      res = await tryHttpBatch({ email, password, port, inputs });
    } catch (err) {
      logWarn('cli', `HTTP batch unreachable, falling back to inline (${err.message || err})`);
      res = { ok: false, reason: 'server unreachable' };
    }
    if (res.ok) {
      for (const r of res.results) {
        const label = r.ticker || r.input;
        if (r.status === 'done') {
          process.stdout.write(`✓ ${label}: ${r.score}/${r.total} (id=${r.id})\n`);
        } else if (r.status === 'pending') {
          process.stdout.write(`… ${label}: queued (#${r.id})\n`);
        } else {
          process.stdout.write(`✗ ${label}: ${r.error || r.status || 'error'} (#${r.id})\n`);
        }
      }
      process.exit(0);
    }
    if (inputs.length > 1) {
      process.stderr.write(`HTTP batch failed (${res.reason}); can't run multi-stock inline.\n`);
      logError('cli', `HTTP batch failed: ${res.reason}`);
      process.exit(1);
    }
    // Single ticker: silently fall through.
    logInfo('cli', `HTTP batch failed, running inline (${res.reason})`);
  }

  // Single-stock inline path (legacy).
  if (inputs.length > 1) {
    process.stderr.write('Multi-stock requires STOCK_QUALITY_EMAIL and STOCK_QUALITY_PASSWORD env vars (and a reachable web server).\n');
    process.exit(2);
  }
  const result = await inlineSingle(inputs[0]);
  if (!result) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  logError('cli', 'unexpected error in main()', err);
  process.exit(1);
});