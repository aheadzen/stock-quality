# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                        # one-time setup
cp .env.example .env               # set MINIMAX_API_KEY

# CLI (single eval)
node src/index.js AAPL
node src/index.js "Berkshire Hathaway"
node src/index.js AAPL --verbose   # full per-question table

# Web UI (local dev — defaults to port 3000)
npm run web
PORT=8080 node src/server.js

# Production (VPS — uses deploy/ecosystem.config.cjs, PORT=3001)
pm2 start /root/code/stock-quality/deploy/ecosystem.config.cjs
pm2 restart stock-quality-web --update-env   # after git pull

# Lint / typecheck (no test suite; `npm test` is a no-op)
node --check src/<file>.js
```

No build step, no transpilation. ES modules (`"type": "module"` in `package.json`).

## Architecture

Four layers; each only depends on the layer below it.

```
entry points ────────────────────────────────────────────────
  src/index.js     CLI: lookup → per-question cache partition → LLM only on missing → save
  src/server.js    HTTP API + queue bootstrap; static-serves public/index.html

orchestration ────────────────────────────────────────────────
  src/queue.js     Background processor. enqueueRequest, startProcessor, getOngoing,
                   getBest. Tick loop runs pending rows with p-limit and a per-row
                   in-memory 429 backoff (`pausedUntil`, resets on process restart).

core eval ────────────────────────────────────────────────────
  src/company.js   lookupCompany (LLM with web_search) + lookupCachedCompany
                   (DB fast-path, 7-day freshness). Tavily enrichment runs when
                   ticker/price are missing. normalizeCompany validates ISO country.
  src/evaluator.js runToolLoop, extractJson, RateLimitError. Strips <think> blocks.
  src/runner.js    runEvaluations with p-limit. With batchSize > 1, chunks into
                   evaluateBatch calls; partial failures surface as per-question errors.

data ─────────────────────────────────────────────────────────
  src/db.js        Schema + idempotent migrations. Single shared better-sqlite3
                   connection (sync).
  src/cache.js     Per-question cache. Each evaluation_factors row is self-keyed on
                   (ticker, question_hash) with 90-day TTL. Exposes questionHash,
                   partitionQuestions, aggregateFactors, findCachedFactors,
                   findFreshEvaluationForQuestions, saveFactor, saveFactors,
                   saveCompany, findCompany.

shared ───────────────────────────────────────────────────────
  src/config.js     loadConfig() — MINIMAX_API_KEY from .env
  src/questions.js  loadQuestions(kind) — {company: [...], crypto: [...]}
  src/prompts.js    buildCompanyLookupMessages + buildEvalMessages + buildTavily…
                    Berkshire committee framing. Company lookup asks for full legal
                    name, price, currency, exchange, country (ISO 3166-1 alpha-2,
                    null for crypto), kind, profile, notes.
  src/client.js     OpenAI client (baseURL=https://api.minimax.io/v1)
  src/output.js     printSummary (compact) + printVerbose (table, --verbose)
  src/tavily.js     Tavily web search wrapper for ticker/price enrichment
```

## Things that aren't obvious

- **Per-question cache key**: `evaluation_factors(ticker, question_hash)`. `question_hash = sha256(JSON.stringify(question))`. Editing one question in `questions.json` only invalidates that one factor across all tickers; the other 24–25 stay cached. The schema migration that denormalized `ticker`/`question_hash`/`evaluated_at` onto `evaluation_factors` is idempotent and runs on every `initDb()`.

- **`/api/best` "complete" check**: a ticker qualifies when its `COUNT(DISTINCT question_hash) >= kind_count` (company=25, crypto=23). SQL is `bestByKindCounts` with a CASE branch per kind. The placeholder order in `getBest(limit, [companyCount, cryptoCount])` is flipped before being passed to the prepared statement because the SQL's WHEN/ELSE branches read crypto-count first, then company-count. Don't desync.

- **Country**: `companies.country` is ISO 3166-1 alpha-2 (e.g. "US", "IN"), null for crypto. The LLM prompt explicitly requires null for crypto; `normalizeCountry(value, kind)` in `company.js` validates the format and rejects anything else. UI shows a `.card-country` badge next to the kind badge; hidden for crypto.

- **CLI must call `recordCompletedRequest()`** to surface in the web UI. Without it, CLI runs only live in `evaluations` and are invisible to `/api/requests`.

- **`saveCompany(company)`** is called from `queue.js#processRequest` and `index.js` after every successful evaluation. Dropping it would freeze `companies` rows at their first-write state — the previous per-question-cache refactor accidentally did this; it was restored.

- **429 backoff is in-memory only** (`pausedUntil = Date.now() + 1h`). Process restarts wipe it. `evaluator.js` rethrows 429s as `RateLimitError` so callers can `instanceof`-check.

- **The web UI's left column is "Recent" (15 cards)**, not strictly in-flight. `getOngoing` returns `pending|processing|done` rows ordered by `updated_at DESC`; errors are returned separately (5-card cap) and render as red cards. `kindCounts()` memoizes the per-kind question counts at server boot.

- **`handlePostReportPreview` and `handlePostReport` query factors directly** by current question hashes (no JOIN through evaluations, no `questions_hash` filter). The "No factors for X against current questions" 404 only fires for tickers with zero factors cached at all.

- **No test suite**. Manual verification:
  - `node --input-type=module -e "import('./src/db.js').then(m => m.initDb()).then(() => console.log('ok'))"` — boot db
  - `sqlite3 data/stock-quality.db "PRAGMA table_info(companies);" | grep country` — confirm migration
  - `node --check src/<file>.js` — syntax check
  - `tail -f data/stock-quality.log` — live errors while the web UI runs

- **`.gitignore` covers `data/`, `*.log`, and `deploy/.env.production`** — DB, log, and any per-server env overrides are excluded.

- **`deploy/ecosystem.config.cjs` is the source of truth for production** — sets `PORT: 3001`, `instances: 1`, autorestart, log paths under `logs/`. Always launch with `pm2 start deploy/ecosystem.config.cjs`. Bare `pm2 start src/server.js` defaults to port 3000 and conflicts with `promptbench` on the VPS. After `git pull`, use `pm2 restart stock-quality-web --update-env`.

- **No package-lock concern on macOS**: `better-sqlite3` ships prebuilt binaries for darwin; `npm install` should succeed without a C++ toolchain.

- **The README is outdated**: it still describes the old SSE `/api/evaluate` endpoint, a single-array `questions.json`, and 23 questions. Current API is poll-based (`GET /api/requests?status=ongoing` and `GET /api/best` every 3s), `questions.json` is `{company: [...], crypto: [...]}` with 25 / 23 questions. Use this file as the source of truth.