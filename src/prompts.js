// Strict-JSON prompt builders for company lookup and per-question evaluation.

export function buildCompanyLookupMessages(input) {
  return [
    {
      role: 'system',
      content:
        'You are a financial data lookup assistant. You must respond with a SINGLE JSON object and nothing else.\n\n' +
        'First, classify the entity into one of these kinds:\n' +
        '- "listed": a publicly listed company trading on a major exchange (e.g. AAPL, RELIANCE, ASML).\n' +
        '- "ipo": a company that has recently IPO\'d (last ~24 months) OR has a confirmed upcoming IPO with a ticker.\n' +
        '- "unlisted": a private company with no public stock listing (e.g. Reliance Jio, Stripe, SpaceX pre-listing).\n' +
        '- "crypto": a cryptocurrency or token (e.g. BTC, ETH, SOL). NOT a crypto exchange\'s stock.\n\n' +
        'Schema:\n' +
        '{' +
        '"kind": "listed" | "ipo" | "unlisted" | "crypto", ' +
        '"ticker": string | null, ' +
        '"name": string, ' +
        '"profile": string, ' +
        '"price": number | null, ' +
        '"currency": string | null, ' +
        '"exchange": string | null, ' +
        '"notes": string | null' +
        '}\n\n' +
        'Rules:\n' +
        '- kind: pick exactly one of the four values above based on the entity.\n' +
        '- profile: ONE or TWO short sentences (max ~200 chars) describing what the entity does. ' +
        '  This is shown to the user as a sanity check that the right company was resolved. ' +
        '  Example: "Designs and sells consumer electronics (iPhone, Mac), software, and services. ' +
        '  Operates the App Store and iCloud ecosystem."\n' +
        '- For "unlisted": set ticker, price, currency, exchange to null. Put the most useful context (e.g. ' +
        '  "Indian conglomerate; private subsidiary of Reliance Industries" or "pre-IPO; last private valuation ' +
        '  ~$95B in 2024") in notes.\n' +
        '- For "crypto": ticker is the symbol (BTC, ETH), price is the current USD price, currency = "USD", ' +
        '  exchange can be null or the dominant exchange (Coinbase, Binance), notes may hold the network/chain.\n' +
        '- For "ipo": ticker exists, price is the IPO price or first-day close, exchange is the listing exchange, ' +
        '  notes should include the IPO date or status (e.g. "IPO 2024-09-12; trading since").\n' +
        '- For "listed": ticker exists, price is the latest available, exchange is the primary listing ' +
        '  (e.g. "NASDAQ", "NYSE", "NSE", "LSE"), notes can be null.\n' +
        '- Use the most recent available price.\n' +
        '- ticker: uppercase ticker symbol (e.g. "AAPL").\n' +
        '- name: full legal/commonly used name.\n' +
        '- price: a JSON number (no commas, no currency symbol). Null if not applicable.\n' +
        '- currency: ISO 4217 code (e.g. "USD", "EUR", "INR"). Null if not applicable.\n' +
        '- Use the web_search tool if you are not certain about any field, especially kind.\n' +
        '- Output ONLY the JSON. No prose, no markdown, no code fences.',
    },
    {
      role: 'user',
      content: `Resolve this entity: "${input}"`,
    },
  ];
}

export function buildEvalMessages(question, companyContext) {
  const { ticker, name, kind } = companyContext;
  const kindLabel = kind ? ` (${kind})` : '';
  const tickerLabel = ticker ? ` (${ticker})` : '';
  return [
    {
      role: 'system',
      content:
        'Act as a Berkshire Hathaway investment and strategy committee evaluating a critical decision for the given company. ' +
        'Our goal is to determine whether the company is a truly great business — one that combines ALL THREE:\n\n' +
        '1. Durable PRICING POWER — the ability to raise prices periodically without losing customers or volume, ' +
        'sustain margins through cost shocks, and resist cheap substitution; pricing-led (not volume-led) revenue growth.\n\n' +
        '2. A MOAT THAT SURVIVES BRUTAL REALITIES — well-funded competitors, employee turnover and IP leakage, ' +
        'disruptive technology, and an absence of structural advantages (network effects, brand mind share, switching costs, ' +
        'product superiority).\n\n' +
        '3. THE ABILITY TO EXPAND RAPIDLY — a market opportunity many times larger than current revenue, untapped or ' +
        'unorganized segments that can be captured, special advantages that compound with scale, easy and cheap access ' +
        'to capital (including franchise or partner models that transfer capital risk), accessible distribution channels, ' +
        'and scalability that does NOT destroy margins or ROE.\n\n' +
        'The checklist you receive mixes all three dimensions. Score 1 when the company demonstrably passes the test on ' +
        'public evidence; score 0 whenever the evidence suggests vulnerability, even if the company appears successful today. ' +
        'Think like Buffett and Munger.\n\n' +
        'You must answer with a SINGLE JSON object and nothing else.\n\n' +
        'Schema:\n' +
        '{"score": 0 | 1, "reasoning": string}\n\n' +
        'Rules:\n' +
        '- score: 1 if the company demonstrates the trait in the question, 0 otherwise.\n' +
        '- reasoning: concise factual justification (1-3 sentences). Cite key numbers, pricing actions, ' +
        '  competitive facts, or recent events you used.\n' +
        '- Use the web_search tool for current data (recent price actions, margin trends, competitive moves, ' +
        '  TAM sizing, capital access, distribution, employee turnover signals, brand metrics).\n' +
        '- For unlisted/private entities, lean on public reporting, founder interviews, press coverage, and ' +
        '  industry analyses rather than exchange filings.\n' +
        '- Output ONLY the JSON. No prose, no markdown, no code fences.',
    },
    {
      role: 'user',
      content: `Company: ${name}${tickerLabel}${kindLabel}\nQuestion: ${question}`,
    },
  ];
}

// Batched variant: receives N questions, asks for a JSON array of length N
// {score, reasoning} objects in the same order. Same Berkshire framing; the
// only difference is response shape and instruction to answer all questions
// in a single response.
export function buildBatchedEvalMessages(questions, companyContext) {
  const { ticker, name, kind } = companyContext;
  const kindLabel = kind ? ` (${kind})` : '';
  const tickerLabel = ticker ? ` (${ticker})` : '';
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'Act as a Berkshire Hathaway investment and strategy committee evaluating a critical decision for the given company. ' +
        'Our goal is to determine whether the company is a truly great business — one that combines ALL THREE:\n\n' +
        '1. Durable PRICING POWER — the ability to raise prices periodically without losing customers or volume, ' +
        'sustain margins through cost shocks, and resist cheap substitution; pricing-led (not volume-led) revenue growth.\n\n' +
        '2. A MOAT THAT SURVIVES BRUTAL REALITIES — well-funded competitors, employee turnover and IP leakage, ' +
        'disruptive technology, and an absence of structural advantages (network effects, brand mind share, switching costs, ' +
        'product superiority).\n\n' +
        '3. THE ABILITY TO EXPAND RAPIDLY — a market opportunity many times larger than current revenue, untapped or ' +
        'unorganized segments that can be captured, special advantages that compound with scale, easy and cheap access ' +
        'to capital (including franchise or partner models that transfer capital risk), accessible distribution channels, ' +
        'and scalability that does NOT destroy margins or ROE.\n\n' +
        `You will receive ${questions.length} questions. For each, decide whether the company demonstrably passes the test on ` +
        'public evidence (score 1) or whether the evidence suggests vulnerability, even if the company appears successful today. ' +
        'Think like Buffett and Munger.\n\n' +
        'Respond with a SINGLE JSON array and nothing else. The array MUST contain exactly ' +
        `${questions.length} objects, in the same order as the questions.\n\n` +
        'Schema for each element:\n' +
        '{"score": 0 | 1, "reasoning": string}\n\n' +
        'Full response shape:\n' +
        `[{"score": 0 | 1, "reasoning": string}, ...]  // exactly ${questions.length} elements\n\n` +
        'Rules:\n' +
        '- score: 1 if the company demonstrates the trait, 0 otherwise.\n' +
        '- reasoning: concise factual justification (1-3 sentences). Cite key numbers, pricing actions, ' +
        '  competitive facts, or recent events you used.\n' +
        '- Use the web_search tool for current data (recent price actions, margin trends, competitive moves, ' +
        '  TAM sizing, capital access, distribution, employee turnover signals, brand metrics).\n' +
        '- For unlisted/private entities, lean on public reporting, founder interviews, press coverage, and ' +
        '  industry analyses rather than exchange filings.\n' +
        '- Output ONLY the JSON array. No prose, no markdown, no code fences, no <think>...</think> blocks.',
    },
    {
      role: 'user',
      content: `Company: ${name}${tickerLabel}${kindLabel}\n\nQuestions:\n${numbered}`,
    },
  ];
}

export function buildStrictRetryMessages(prev) {
  return [
    {
      role: 'system',
      content:
        'Your previous response was not valid JSON. You MUST respond with a SINGLE JSON object and nothing else. ' +
        'No prose, no markdown fences, no <think>...</think> blocks, no commentary before or after.',
    },
    {
      role: 'user',
      content:
        `Your last answer was:\n\n${prev}\n\n` +
        'Resend the SAME answer but formatted strictly as JSON matching the requested schema. ' +
        'Do NOT include any thinking, reasoning, or commentary before the JSON.',
    },
  ];
}