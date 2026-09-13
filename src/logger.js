// Tiny logger that emits to stderr and appends to data/stock-quality.log.
// CLI and web server share this so we have a single, persistent place to
// inspect failures.

import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('./data');
const LOG_PATH = path.join(LOG_DIR, 'stock-quality.log');

function ts() {
  return new Date().toISOString();
}

function write(level, category, message, error) {
  const head = `[${ts()}] [${level}] [${category}] ${message}`;
  const tail = error
    ? error.stack
      ? `\n${error.stack}`
      : ` ${error.message || error}`
    : '';
  const line = head + tail;
  // stderr for the operator's terminal
  try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
  // file for after-the-fact debugging
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // If we can't write the log file, the stderr line is still there.
  }
}

export function logInfo(category, message) {
  write('INFO', category, message);
}
export function logWarn(category, message) {
  write('WARN', category, message);
}
export function logError(category, message, error) {
  write('ERROR', category, message, error);
}

export function getLogPath() {
  return LOG_PATH;
}