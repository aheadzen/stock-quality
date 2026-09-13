#!/usr/bin/env node
import process from 'node:process';
import { loadConfig } from './config.js';
import { getClient } from './client.js';
import { loadQuestions } from './questions.js';
import { resolveInput } from './input.js';
import { lookupCompany, lookupCachedCompany } from './company.js';
import { runEvaluations } from './runner.js';
import { initDb } from './db.js';
import { questionsHash, findFreshEvaluation, saveEvaluation } from './cache.js';
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

  const hash = questionsHash(questions);
  const cached = findFreshEvaluation(company.ticker, hash);
  if (cached) {
    process.stderr.write(
      `Cache hit (within 90 days). Score: ${cached.score} / ${cached.total}\n`
    );
    recordCompletedRequest(input, company.ticker, cached.score, cached.total);
    const syntheticResults = questions.map((q, i) => ({
      index: i,
      question: q,
      score: i < cached.score ? 1 : 0,
      reasoning: '(from cache — see DB for original reasoning)',
    }));
    printSummary(company, syntheticResults, { source: 'cache' });
    if (VERBOSE) printVerbose(company, syntheticResults);
    process.exit(0);
  }

  const { questions: QUESTION_CONCURRENCY } = getConcurrency();
  process.stderr.write(
    `Evaluating ${questions.length} question${questions.length === 1 ? '' : 's'} (concurrency ${QUESTION_CONCURRENCY})...\n`
  );
  let results;
  try {
    results = await runEvaluations(client, questions, company, {
      concurrency: QUESTION_CONCURRENCY,
    });
  } catch (err) {
    logError('cli', `runEvaluations failed for "${input}"`, err);
    process.exit(1);
  }

  const saved = saveEvaluation({
    ticker: company.ticker,
    company,
    results,
    questionsHashValue: hash,
  });

  recordCompletedRequest(input, company.ticker, saved.score, saved.total);

  printSummary(company, results, { source: 'fresh' });
  if (VERBOSE) printVerbose(company, results);
  process.exit(0);
}

main().catch((err) => {
  logError('cli', 'unexpected error in main()', err);
  process.exit(1);
});