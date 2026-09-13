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

# Web UI
npm run web                        # http://localhost:3000
PORT=8080 node src/server.js

# Lint / typecheck (no test suite exists yet — `npm test` is a no-op)
node --check <file>                # syntax check a single .js file
```

No build step, no transpilation. ES modules (`"type": "module"` in `package.json`).

## Architecture

Four layers; each only depends on the layer below it.

```
entry points ────────────────────────────────────────────────
  src/index.js     CLI: cache check → LLM eval → save → record done row
  src/server.js    HTTP API + queue bootstrap; static-serves public/index.html

orchestration ────────────────────────────────────────────────
  src/queue.js     Background processor. Owns: in-memory `pausedUntil`,
                   request lifecycle (pending→processing→done|error),
                   enqueueRequest / startProcessor / getOngoing / getBest.
                   Single tick loop pulls `LIMIT stockSearchConcurrency`
                   pending rows and runs them with Promise.all.

core eval ────────────────────────────────────────────────────
  src/company.js   lookupCompany (LLM) + lookupCachedCompany (DB fast-path
                   for ticker-shaped inputs, 7-day freshness window)
  src/evaluator.js runToolLoop, extractJson, RateLimitError
                   Strips <think>...</think> blocks before JSON parsing.
  src/runner.js    runEvaluations with p-limit(N from settings).

data ─────────────────────────────────────────────────────────
  src/db.js        Schema + prepared statements. Single shared
                   better-sqlite3 connection (sync). Idempotent CREATE IF
                   NOT EXISTS migrations run on initDb().
  src/cache.js     findFreshEvaluation / saveEvaluation. Cache key is
                   (ticker, sha256(JSON.stringify(questions))). TTL 90d.
                   evaluation_factors is never serialized to the API.
  src/settings.js  Loads config.json; falls back to safe defaults if
                   missing or invalid.
  src/logger.js    stderr + append-only data/stock-quality.log.

shared ───────────────────────────────────────────────────────
  src/config.js    loadConfig() — MINIMAX_API_KEY from .env
  src/questions.js loadQuestions() — reads ./questions.json
  src/prompts.js   System/user prompt builders (Berkshire committee framing)
  src/tools.js     web_search tool definition
  src/client.js    OpenAI client (baseURL=https://api.minimax.io/v1)
  src/output.js    printSummary (compact one-liner) + printVerbose (table)
  src/input.js     CLI arg / readline prompt resolution
```

## Things that aren't obvious

- **Cache key**: `(ticker, questions_hash)`. `questions_hash = sha256(JSON.stringify(questions))`. Editing `questions.json` invalidates every cached evaluation. `getBest` filters by current hash so old evaluations don't pollute the "best" list.
- **429 backoff is in-memory only** (`pausedUntil = Date.now() + 1h` in `queue.js`). Process restarts wipe it. `evaluator.js` rethrows 429s as `RateLimitError` so callers can `instanceof`-check.
- **CLI must call `recordCompletedRequest()`** to be visible in the web UI — without it, CLI runs only live in the `evaluations` table and don't appear in `/api/requests`.
- **`getOngoing()` includes `done` rows** ordered by `updated_at DESC`. The left dashboard column is "recent activity", not strictly in-flight. Errors are returned separately under `errors` and render as red cards.
- **No test suite**. Manual verification commands live in the plan transcript; standard ones:
  - `node --input-type=module -e "import('./src/db.js').then(m => m.initDb()).then(() => console.log('ok'))"`
  - `node --check src/<file>.js` for syntax
- **Logs**: `data/stock-quality.log` is appended by both CLI and web server. `tail -f` it while running the web UI to see live errors.
- **`.gitignore` does not exclude `data/stock-quality.db` or `data/stock-quality.log`** — only `.env*`, `node_modules/`, `*.log`. If you don't want the DB committed, add `data/stock-quality.db` and `data/stock-quality.log` to `.gitignore`.
- **The README is outdated**: it still describes the old SSE `/api/evaluate` endpoint and a single-table CLI output. The current web UI polls `GET /api/requests?status=ongoing` and `GET /api/best` every 3s, and the CLI's default output is a one-line summary (use `--verbose` for the table).
- **No package-lock concern on macOS**: `better-sqlite3` ships prebuilt binaries for darwin; `npm install` should succeed without a C++ toolchain.