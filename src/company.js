import { runToolLoop, extractJson } from './evaluator.js';
import { buildCompanyLookupMessages } from './prompts.js';
import { findCompany, saveEvaluation } from './cache.js';

const VALID_KINDS = ['listed', 'ipo', 'unlisted', 'crypto'];

const TICKER_SHAPE = /^[A-Z][A-Z0-9.\-]{0,5}$/;

// Returns true if `input` looks like a bare ticker symbol that we can resolve
// from the companies cache directly without an LLM round-trip.
function looksLikeTicker(input) {
  return TICKER_SHAPE.test((input || '').trim().toUpperCase());
}

export async function lookupCachedCompany(input) {
  if (!looksLikeTicker(input)) return null;
  const ticker = input.trim().toUpperCase();
  const row = findCompany(ticker);
  if (!row) return null;
  // Only reuse if the metadata is fresh enough (7 days).
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - (row.fetched_at || 0) > SEVEN_DAYS) return null;
  return row;
}

export async function lookupCompany(client, input, { signal } = {}) {
  const messages = buildCompanyLookupMessages(input);
  let raw = await runToolLoop(client, messages, { maxIterations: 5, signal });

  let parsed = extractJson(raw);
  if (parsed && isValidCompanyShape(parsed)) {
    return normalizeCompany(parsed);
  }

  // Retry once by appending the previous assistant turn + a corrective system note.
  const messages2 = [
    ...messages,
    { role: 'assistant', content: raw },
    {
      role: 'system',
      content:
        'Your previous response was not valid JSON. You MUST respond with a SINGLE JSON object matching the requested schema ' +
        '({kind, ticker, name, profile, price, currency, exchange, notes}). No prose, no markdown, no code fences, ' +
        'no <think>...</think> blocks.',
    },
    {
      role: 'user',
      content:
        `Your last answer was:\n\n${raw}\n\n` +
        'Resend the SAME answer but formatted strictly as JSON with keys: kind, ticker, name, profile, price, currency, exchange, notes. ' +
        'Set ticker/price/currency/exchange to null if not applicable (e.g. unlisted company). ' +
        'Do NOT include any thinking, reasoning, or commentary before the JSON — emit the JSON object as your first character.',
    },
  ];
  raw = await runToolLoop(client, messages2, { maxIterations: 5, signal });
  parsed = extractJson(raw);
  if (parsed && isValidCompanyShape(parsed)) {
    return normalizeCompany(parsed);
  }

  throw new Error(
    `Failed to parse company lookup JSON. Raw: ${truncate(raw)}`
  );
}

function isValidCompanyShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false;
  if (typeof obj.profile !== 'string' || !obj.profile.trim()) return false;
  const kind = obj.kind || 'listed';
  if (!VALID_KINDS.includes(kind)) return false;

  // For unlisted, ticker/price/currency may be null.
  if (kind === 'unlisted') {
    return true;
  }

  // For listed/ipo/crypto, ticker + price + currency are required.
  if (typeof obj.ticker !== 'string' || !obj.ticker.trim()) return false;
  if (typeof obj.price !== 'number' || !Number.isFinite(obj.price)) return false;
  if (typeof obj.currency !== 'string' || !obj.currency.trim()) return false;
  return true;
}

function normalizeCompany(obj) {
  const kind = VALID_KINDS.includes(obj.kind) ? obj.kind : 'listed';
  const isMarketable = kind !== 'unlisted';
  return {
    kind,
    ticker: isMarketable && typeof obj.ticker === 'string' ? obj.ticker.trim().toUpperCase() : null,
    name: obj.name.trim(),
    profile: typeof obj.profile === 'string' ? obj.profile.trim() : '',
    price: isMarketable && typeof obj.price === 'number' ? obj.price : null,
    currency: isMarketable && typeof obj.currency === 'string' ? obj.currency.trim().toUpperCase() : null,
    exchange: typeof obj.exchange === 'string' && obj.exchange.trim() ? obj.exchange.trim() : null,
    notes: typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim() : null,
  };
}

function truncate(s, n = 300) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}...` : s;
}