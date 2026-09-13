#!/usr/bin/env node
import process from 'node:process';
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

  const client = getClient();

  let input;
  try {
    input = await resolveInput();
  } catch (err) {
    if (err && err.code === 'ABORT_ERR') {
      process.stderr.write('\nNo input provided (stdin closed).\n');
    } else {
      logError('cli', 'failed to read input', err);
    }
    process.exit(1);
  }

  logInfo('cli', `lookup start: input="${input}"`);
  let company = await lookupCachedCompany(input);
  if (!company) {
    try {
      company = await lookupCompany(client, input);
    } catch (err) {
      logError('cli', `company lookup failed for "${input}"`, err);
      process.exit(1);
    }
  } else {
    process.stderr.write(`(company metadata from cache)\n`);
  }
  if (!company) {
    process.stderr.write(
      `Could not resolve a ticker for "${input}". Only listed/IPO/crypto entities can be scored.\n`
    );
    process.exit(1);
  }
  process.stderr.write(
    `Company: ${company.name} (${company.ticker}) — ${company.price ?? 'n/a'} ${company.currency ?? ''}\n`
  );

  // Pick the question set for this entity's kind. Listed/IPO/unlisted share
  // the company set; crypto has its own.
  let questions;
  try {
    questions = loadQuestions(company.kind);
  } catch (err) {
    logError('cli', `questions load failed for kind=${company.kind}`, err);
    process.exit(1);
  }

  // Per-question cache check. Full cache hit means every current question has
  // a fresh factor cached for this ticker → no LLM call needed.
  const cached = findFreshEvaluationForQuestions(company.ticker, questions);
  if (cached) {
    process.stderr.write(
      `Cache hit (within 90 days). Score: ${cached.score} / ${cached.total}\n`
    );
    // Persist company metadata even on a full cache hit so the ticker stays
    // visible in the web UI with its full name (see src/queue.js for the
    // matching path).
    saveCompany(company);
    recordCompletedRequest(input, company.ticker, cached.score, cached.total);
    const { cached: cachedResults } = partitionQuestions(company.ticker, questions);
    printSummary(company, cachedResults, { source: 'cache' });
    if (VERBOSE) printVerbose(company, cachedResults);
    process.exit(0);
  }

  // Cache miss: partition into cached + missing. Only missing questions go
  // to the LLM. Each new factor is persisted via onResult so a crash mid-run
  // still leaves the row in a recoverable state.
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
        } catch {
          /* never let a cache write kill the run */
        }
      },
    });
  } catch (err) {
    logError('cli', `runEvaluations failed for "${input}"`, err);
    process.exit(1);
  }

  saveFactors(company.ticker, results);
  saveCompany(company);

  const { score, total } = aggregateFactors(results);
  recordCompletedRequest(input, company.ticker, score, total);

  // Merge cached + new for the CLI output so the operator sees the full set.
  const merged = [...cachedResults, ...results].sort((a, b) => a.index - b.index);

  printSummary(company, merged, { source: 'fresh' });
  if (VERBOSE) printVerbose(company, merged);
  process.exit(0);
}

main().catch((err) => {
  logError('cli', 'unexpected error in main()', err);
  process.exit(1);
});