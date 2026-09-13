// Loads config.json from the project root. Falls back to safe defaults if the
// file is missing, malformed, or contains invalid types. Modules import the
// already-validated values via getSettings() / getConcurrency() — settings are
// loaded once and cached.

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve('./config.json');

const DEFAULTS = Object.freeze({
  questionConcurrency: 5,
  stockSearchConcurrency: 2,
  reportPasscode: '1234',
  batchSize: 5,
});

let cached = null;

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;
}

function isValidBatchSize(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 50;
}

function isValidPasscode(s) {
  return typeof s === 'string' && /^\d{4}$/.test(s);
}

function validate(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (isPositiveInt(raw.questionConcurrency)) {
      out.questionConcurrency = raw.questionConcurrency;
    }
    if (isPositiveInt(raw.stockSearchConcurrency)) {
      out.stockSearchConcurrency = raw.stockSearchConcurrency;
    }
    if (isValidPasscode(raw.reportPasscode)) {
      out.reportPasscode = raw.reportPasscode;
    }
    if (isValidBatchSize(raw.batchSize)) {
      out.batchSize = raw.batchSize;
    }
  }
  return Object.freeze(out);
}

export function loadSettings() {
  let raw = null;
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(
        `[settings] failed to read ${CONFIG_PATH}: ${err.message}. Using defaults.\n`
      );
    }
    raw = null;
  }
  cached = validate(raw);
  return cached;
}

export function getSettings() {
  if (!cached) loadSettings();
  return cached;
}

export function getConcurrency() {
  const s = getSettings();
  return {
    questions: s.questionConcurrency,
    stockSearch: s.stockSearchConcurrency,
    batchSize: s.batchSize,
  };
}

export function getConfigPath() {
  return CONFIG_PATH;
}