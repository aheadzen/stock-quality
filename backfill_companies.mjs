// Backfill missing `companies` rows for tickers that have evaluation_factors
// but no metadata. Each ticker is resolved via `lookupCompany` (LLM call) and
// then `saveCompany`. The 25 cached factors are reused — no LLM call for the
// questions.
//
// Usage: node backfill_companies.mjs [ticker1] [ticker2] ...
//   No args: backfill all orphans.
//   With args: only backfill the listed tickers (must be exact ticker strings,
//   e.g. node backfill_companies.mjs TITAN PINELABS).
//
// Requires MINIMAX_API_KEY to be set. Idempotent — safe to re-run.

import process from 'node:process';
import { loadConfig } from './src/config.js';
import { initDb, getDb, closeDb } from './src/db.js';
import { getClient } from './src/client.js';
import { lookupCompany } from './src/company.js';
import { saveCompany } from './src/cache.js';

loadConfig();
initDb();
const db = getDb();
const client = getClient();

const onlyThese = process.argv.slice(2);
const orphans = onlyThese.length > 0
  ? onlyThese.map((t) => ({ ticker: t.toUpperCase() }))
  : db.prepare(`
      SELECT DISTINCT f.ticker
      FROM evaluation_factors f
      LEFT JOIN companies c ON c.ticker = f.ticker
      WHERE c.ticker IS NULL
      ORDER BY f.ticker
    `).all();

if (orphans.length === 0) {
  console.log('No orphaned tickers — nothing to backfill.');
  closeDb();
  process.exit(0);
}

console.log(`Backfilling ${orphans.length} ticker(s): ${orphans.map((o) => o.ticker).join(', ')}`);

let ok = 0;
let failed = 0;
for (const { ticker } of orphans) {
  process.stderr.write(`  ${ticker} ... `);
  try {
    const company = await lookupCompany(client, ticker);
    if (!company || !company.ticker) {
      process.stderr.write('LLM returned no ticker, skipping\n');
      failed++;
      continue;
    }
    saveCompany(company);
    process.stderr.write(`saved as "${company.name}" (${company.kind}, ${company.country ?? 'n/a'})\n`);
    ok++;
  } catch (err) {
    process.stderr.write(`FAILED: ${err.message || err}\n`);
    failed++;
  }
}

console.log(`\n${ok} saved, ${failed} failed.`);
closeDb();
process.exit(failed > 0 ? 1 : 0);