// Tavily web search wrapper. Used as a fallback source of truth when the LLM
// can't resolve ticker or price on its own (e.g. recently-listed companies
// beyond its training-data cutoff).
//
// Reads the API key from `process.env['TAVILY_API-KEY']` lazily so importing
// this module never throws on its own — only when search() is actually called.

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

function getApiKey() {
  // dotenv preserves the literal key name from .env, including the hyphen.
  const key = process.env['TAVILY_API-KEY'];
  if (!key) {
    throw new Error(
      'TAVILY_API-KEY is not set. Add it to .env to enable the Tavily fallback.'
    );
  }
  return key;
}

// Run a single Tavily search and return the raw response.
// Options:
//   searchDepth: 'basic' (default) | 'advanced'
//   maxResults:   default 5
//   includeAnswer: default true (synthesized answer string)
//   topic:        omitted unless explicitly set — Tavily uses 'general' as
//                  its own default. We deliberately don't pin it: Tavily has a
//                  dedicated 'finance' topic but the data we want (stock
//                  screener pages, news articles, exchange filings) lives on
//                  the general web, and pinning has produced relevance misses
//                  in practice (e.g. "Molbio Diagnostics" returning
//                  Co-Diagnostics data).
export async function tavilySearch(query, opts = {}) {
  const {
    searchDepth = 'advanced',
    maxResults = 5,
    includeAnswer = true,
    topic,
  } = opts;

  const body = {
    api_key: getApiKey(),
    query,
    search_depth: searchDepth,
    max_results: maxResults,
    include_answer: includeAnswer,
  };
  if (topic) body.topic = topic;

  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return res.json();
}

// Convenience: format Tavily results into a compact text blob suitable for
// feeding back into an LLM extraction prompt. Keeps the synthesized answer
// (if present) plus the top N result snippets.
export function formatTavilyForPrompt(tavilyResult, { maxSnippets = 5 } = {}) {
  const parts = [];
  if (tavilyResult.answer) {
    parts.push(`SYNTHESIZED ANSWER:\n${tavilyResult.answer}`);
  }
  const results = Array.isArray(tavilyResult.results) ? tavilyResult.results.slice(0, maxSnippets) : [];
  if (results.length) {
    parts.push('TOP RESULTS:');
    results.forEach((r, i) => {
      const title = r.title || r.url || `result ${i + 1}`;
      const content = r.content || '';
      parts.push(`[${i + 1}] ${title}\n${content}`);
    });
  }
  return parts.join('\n\n');
}
