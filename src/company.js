import { runToolLoop, extractJson } from './evaluator.js';
import { buildCompanyLookupMessages, buildTavilyExtractionMessages } from './prompts.js';
import { findCompany } from './cache.js';
import { tavilySearch, formatTavilyForPrompt } from './tavily.js';

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

  // Ticker / price / currency may be null for any kind. The queue runs Tavily
  // enrichment to fill missing marketable fields; if that also fails the
  // request fails downstream with a clear "could not resolve ticker" message.
  return true;
}

// Validate ISO 3166-1 alpha-2: two uppercase letters. Anything else is dropped
// to null — a malformed country code is worse than missing because the UI
// shows it next to the company name.
function normalizeCountry(value, kind) {
  if (kind === 'crypto') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
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
    country: normalizeCountry(obj.country, kind),
    notes: typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim() : null,
  };
}

function truncate(s, n = 300) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// Run several Tavily queries in parallel and combine their results into a
// single formatted blob. Tavily's relevance is query-sensitive — one phrasing
// may return wrong-company results (e.g. "Molbio Diagnostics" returning
// Co-Diagnostics data), so we probe multiple phrasings and let the LLM
// extractor see all of them. We keep at most 3 unique results per query to
// bound prompt size.
async function tavilyMultiSearch(queries) {
  // Don't pass `topic` — let Tavily pick its default. The dedicated 'finance'
  // topic produced relevance misses (e.g. Molbio Diagnostics → Co-Diagnostics),
  // and the data we want (stock screener pages, news) lives on the general web.
  const settled = await Promise.allSettled(
    queries.map((q) => tavilySearch(q))
  );

  const parts = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    const q = queries[i];
    parts.push(`--- Query ${i + 1}: ${q} ---`);
    parts.push(formatTavilyForPrompt(r.value, { maxSnippets: 3 }));
  }
  return parts.join('\n\n');
}

// Fallback enrichment: when the LLM couldn't resolve ticker or price (often
// because the company's listing is beyond the model's training cutoff), ask
// Tavily and use a focused LLM extraction pass over the search snippets to
// fill in the missing fields. Returns the original company unchanged if
// nothing is missing or if every fallback attempt fails.
//
// If the company was classified as 'unlisted' but Tavily finds a real
// ticker, the kind is upgraded to 'listed' (best default for a confirmed
// public listing). The price search then runs as well.
export async function enrichCompanyWithTavily(client, input, company) {
  if (!company) return company;

  const needsTicker = !company.ticker;

  // Use the resolved name when available — the LLM lookup often canonicalizes
  // "pine labs" → "Pine Labs Limited", and full names yield better Tavily hits.
  const name = (company.name && company.name.trim()) || input;

  let next = { ...company };

  if (needsTicker) {
    try {
      const queries = [
        `${name} company ticker symbol exchange listing stock code`,
        `${name} NSE BSE ticker stock code listing`,
        `${name} IPO listing date ticker symbol`,
      ];
      const formatted = await tavilyMultiSearch(queries);
      const messages = buildTavilyExtractionMessages(name, formatted, 'ticker');
      const raw = await runToolLoop(client, messages);
      const parsed = extractJson(raw);
      if (parsed && typeof parsed === 'object') {
        const ticker = typeof parsed.ticker === 'string' && parsed.ticker.trim()
          ? parsed.ticker.trim().toUpperCase()
          : null;
        const exchange = typeof parsed.exchange === 'string' && parsed.exchange.trim()
          ? parsed.exchange.trim()
          : null;
        if (ticker) {
          next = { ...next, ticker, exchange: exchange || next.exchange };
          // Upgrade kind if Tavily confirms a public listing.
          if (next.kind === 'unlisted') next = { ...next, kind: 'listed' };
        }
      }
    } catch (err) {
      // Best-effort: log nothing here; the caller decides how to surface this.
      // Swallow so a Tavily failure doesn't kill an otherwise-usable result.
      next.__tickerFallbackError = err.message || String(err);
    }
  }

  // Re-evaluate after ticker enrichment: the kind may have been upgraded from
  // 'unlisted' to 'listed', in which case we now need a price.
  const needsPrice =
    next.kind !== 'unlisted' &&
    (next.price == null || !Number.isFinite(next.price));

  if (needsPrice && next.ticker) {
    try {
      const queries = [
        `${name} ${next.ticker} current stock price today`,
        `${name} ${next.ticker} share price NSE BSE`,
      ];
      const formatted = await tavilyMultiSearch(queries);
      const messages = buildTavilyExtractionMessages(name, formatted, 'price');
      const raw = await runToolLoop(client, messages);
      const parsed = extractJson(raw);
      if (parsed && typeof parsed === 'object') {
        const price = typeof parsed.price === 'number' && Number.isFinite(parsed.price)
          ? parsed.price
          : null;
        const currency = typeof parsed.currency === 'string' && parsed.currency.trim()
          ? parsed.currency.trim().toUpperCase()
          : null;
        if (price != null) {
          next = { ...next, price, currency: currency || next.currency };
        }
      }
    } catch (err) {
      next.__priceFallbackError = err.message || String(err);
    }
  }

  // Strip internal diagnostic fields before returning — callers see a clean
  // company object.
  delete next.__tickerFallbackError;
  delete next.__priceFallbackError;
  return next;
}