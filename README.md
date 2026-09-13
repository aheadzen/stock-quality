# Investment Quality

> *Prepare for the worst, hope for the best.*

A Node.js CLI that uses the **MiniMax API** (with web search) to evaluate a stock as a **Berkshire investment committee**. The current 23-question checklist tests three dimensions: **durable pricing power** (raise prices without losing customers, sustain margins through cost shocks, resist cheap substitution), **a moat that survives brutal realities** (well-funded competitors, employee/IP leakage, disruptive technology, network effects, brand mind share), and **the ability to expand rapidly** (large TAM, untapped segments, capital access, distribution, scalable economics).

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and set MINIMAX_API_KEY=<your-key>
```

## Web UI

A vanilla HTML/JS UI is included. It streams results live via SSE as each question completes.

```bash
npm run web           # listens on http://localhost:3000
# or:
PORT=8080 node src/server.js
```

Endpoints:
- `GET /` — the UI
- `GET /api/health` — `{ok: true}`
- `POST /api/evaluate` — body `{input: "AAPL"}`, returns `text/event-stream` with events:
  - `event: status` — `{stage: "lookup" | "evaluating", ...}`
  - `event: company` — `{kind, ticker, name, price, currency, exchange, notes}` (kind: `listed` | `ipo` | `unlisted` | `crypto`)
  - `event: result` — one per question as it completes
  - `event: done` — end-of-stream marker (totals are computed client-side)
  - `event: error` — fatal error message

## Usage

```bash
# Provide a ticker or company name
node src/index.js AAPL
node src/index.js "Berkshire Hathaway"

# Or run interactively (will prompt)
node src/index.js
```

## Configuring questions

Edit `questions.json` to change the evaluation checklist:

```json
{
  "questions": [
    "Does the company have a durable competitive moat?",
    "..."
  ]
}
```

## How it works

1. Loads questions from `questions.json`
2. Resolves the company name/ticker (argv or prompt)
3. Asks MiniMax to look up the entity and classify it as `listed`, `ipo`, `unlisted`, or `crypto` (uses `web_search`)
4. For each question, asks MiniMax (as the Berkshire committee) to score `0` or `1` with reasoning (uses `web_search`)
5. Prints the summary table with total and percentage

## Output

```
Looking up company "AAPL"...
Company: Apple Inc. (AAPL) — 247.85 USD
Evaluating 23 questions (concurrency 5)...

Company: Apple Inc. (AAPL)   LISTED
Price:   247.85 USD
Exchange: NASDAQ

#    Question                                           Score Reasoning
-----------------------------------------------------------------------
   1 Can the company increase prices every year or …       1 ...
   ...
  23 Is there some virality or network effect built …       1 ...

Total: 19 / 23 (82.6%)
```

The company card adapts to the entity kind:
- **`listed`** — name, ticker, exchange, latest price.
- **`ipo`** — name, ticker, exchange, IPO date in notes.
- **`unlisted`** — name only; no ticker/price. Notes carry private valuation or context.
- **`crypto`** — name, ticker, price, network/chain in notes.

## Notes

- Built-in `readline/promises` powers the interactive prompt (no extra dep).
- Concurrency is capped at 5 via `p-limit`. Drop to 2–3 if you hit rate limits.
- A single failing question becomes an `ERR` row and is excluded from the total.