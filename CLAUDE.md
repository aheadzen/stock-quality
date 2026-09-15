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

# CLI (multi-stock — requires auth + reachable web server)
STOCK_QUALITY_EMAIL=admin@example.com STOCK_QUALITY_PASSWORD=adminpass1 \
  node src/index.js AAPL,MSFT,GOOG
STOCK_QUALITY_EMAIL=admin@example.com STOCK_QUALITY_PASSWORD=adminpass1 \
  node src/index.js --file tickers.txt    # one per line

# Bootstrap admin (idempotent — re-run to reset password + role)
node src/seed-admin.js admin@example.com adminpass1

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

Five layers; each only depends on the layer below it.

```
entry points ────────────────────────────────────────────────
  src/index.js     CLI: single-stock inline OR multi-stock via HTTP /api/requests
                   (logs in with STOCK_QUALITY_EMAIL/PASSWORD env vars). Falls back
                   to inline only when no env vars set or server unreachable.
  src/server.js    HTTP API + queue bootstrap; static-serves public/index.html.
                   Cookie-based auth on every request via attachUser(req).

orchestration ────────────────────────────────────────────────
  src/queue.js     Background processor. enqueueRequest is pure-DB (hot path):
                   full cache hit → 'done' synchronously, else insert pending and
                   return immediately. Background tick loop runs pending rows
                   with p-limit and a per-row in-memory 429 backoff (`pausedUntil`,
                   resets on process restart).
  src/auth.js      bcryptjs (12 rounds) + opaque 32-byte hex session tokens in
                   SQLite. Cookie `sid` HttpOnly + SameSite=Strict + Secure in prod.
                   requireAuth / requireAdmin middleware. In-memory login rate
                   limit (5/IP/15min) and batch rate limit (200/user/hour).

users + lists ─────────────────────────────────────────────────
  src/users.js     createUser (bcrypt hash + 8-char min), findUserByEmail/Id,
                   setUserRole, deleteUser (cascades sessions + lists via FK,
                   requests.user_id → NULL via ON DELETE SET NULL).
                   constantTimeVerifyPassword against dummy hash for email
                   enumeration resistance.
  src/lists.js     Per-user private lists. UNIQUE(user_id, name). Items are
                   tickers joined to companies + latest completed request score.
                   exportListCsv prefixes cells starting with =, +, -, @, \t, \r
                   with `'` to block Excel formula injection.
  src/seed-admin.js  CLI: `node src/seed-admin.js <email> <password>` — creates
                   an admin user or resets an existing one (idempotent).

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

## Auth + multi-stock gotchas

- **`enqueueRequest` is pure-DB (no LLM call)**. It calls `lookupCachedCompany` (DB-only) and only the full cache-hit fast-path returns synchronously as `'done'`. Everything else inserts a pending row and returns immediately — the hot path was the UX bug where the web UI blocked on the company-lookup LLM call before showing the card. The background processor (`processRequest`) handles company lookup + evaluation asynchronously and updates the same row. For ticker-shaped input, the row's `ticker` column is pre-filled from the input shape so the card shows the ticker immediately even before the LLM resolves company metadata.

- **`/api/requests` shape**: `{input}` is single-stock (anonymous OK, backward compat), `{inputs:[...]}` is multi-stock (auth required, capped at 50, returns `{results: [{input,id,status,ticker?,score?,total?}]}`). The UI batches via `POST /api/evaluate/upload {csv, listId?, newListName?}` which auto-creates a list and adds items.

- **Per-user `GET /api/requests` filter**: anon sees the **public** recent — rows where `user_id IS NULL` (anonymous activity + legacy rows from before the column existed). Regular user filters `WHERE user_id = ?` (excludes legacy NULL rows). Admin sees all rows including legacy. Implemented as inline helpers in `server.js`: `getOngoingFor`/`getRecentErrorsFor` branch on `user.role === 'admin'`; anon uses parallel `getOngoingPublic`/`getRecentErrorsPublic` that filter `WHERE user_id IS NULL`.

- **List naming**: `UNIQUE(user_id, name)` — same name allowed for different users but not twice for the same user. `createList` and `updateListName` both check the constraint and return `409` via the wrapped `Error`.

- **Admin self-protection**: `requireAdmin` blocks role change/deletion of your own user with 400. `setUserRole(id, 'user')` where `id === admin.id` is rejected. `deleteUser(id)` where `id === admin.id` is rejected.

- **Cookie `Secure` flag** is auto-set when `NODE_ENV === 'production'`. Local dev stays on http — don't set `NODE_ENV=production` for `npm run web`.

- **`requests.user_id` migration**: legacy rows keep `user_id = NULL`. `deleteUser()` sets `requests.user_id = NULL` via `ON DELETE SET NULL`. The DB migration that adds the column is idempotent (checks `PRAGMA table_info` first) and runs on every `initDb()`.