# ReachInbox

ReachInbox is a development email-campaign scheduler with a React dashboard. It imports recipient lists, persists scheduled email records in PostgreSQL, queues delivery jobs through BullMQ/Redis, and provides Google sign-in, sent-email search, and optional Slack alerts when a sender limit is reached.

> **Email delivery is development-only by default.** The worker creates an Ethereal test account dynamically and sends through Ethereal SMTP. Ethereal captures messages for preview; it does not deliver them to real recipient inboxes. Gmail SMTP is not implemented.

## Features

### Backend

- Google OAuth 2.0 login with verified Google identity, PostgreSQL-backed Express sessions, and authenticated, user-scoped campaign and lead APIs.
- Campaign creation, CSV lead import, and PostgreSQL persistence for scheduled email records.
- Batched scheduling into BullMQ with stable job IDs, backed by Redis persistence.
- Per-sender fixed-window capacity limits, minimum send spacing, and bounded worker concurrency.
- Ethereal SMTP test delivery with BullMQ retries and database status/log updates.
- Elasticsearch search over sent messages.
- Optional Slack OAuth connection using incoming webhooks encrypted at rest; rate-limit alerts are sent by a separate Slack notification worker.
- Authenticated Bull Board queue UI at `/admin/queues` when credentials are configured.

### Frontend

- Google sign-in and session-aware dashboard.
- Dashboard, campaigns, leads, Scheduled and Sent email views, email details, search, and a queue/health page.
- Compose flow with recipient entry, CSV/text parsing, duplicate/invalid counts, subject/body, scheduled time, and minimum delay controls.
- Slack connect, status, reconnect, and disconnect controls.

## Technology

- Frontend: React 18, TypeScript, Vite, Tailwind CSS 4, React Router.
- Backend: Node.js, TypeScript, Express 5.
- Persistence and queue: PostgreSQL, Redis, BullMQ.
- Mail and search: Nodemailer with Ethereal SMTP, Elasticsearch.
- Integrations: Google OAuth 2.0 and Slack OAuth 2.0 / Incoming Webhooks.

## Prerequisites

- Node.js 20.6 or newer (Node.js 22 LTS recommended) and npm.
- Docker Desktop with Docker Compose.
- Google OAuth client credentials for interactive Google sign-in.
- A Slack app/workspace only if demonstrating live Slack integration.
- At least 4 GB memory available to Docker is recommended; the Elasticsearch container is configured with a 1 GB limit.

PostgreSQL, Redis, and Elasticsearch are provided by the repository's Docker Compose configuration. You may instead run compatible local services and adjust the environment variables.

## Configure environment

From the project root, create a private local environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace placeholders before starting the API. The example database password is only a local placeholder: use a strong private value and put the same value in `POSTGRES_PASSWORD` and `DATABASE_URL`. Do not commit `.env`.

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | No | Set `development` locally; production cookies require `production` and HTTPS URLs. |
| `PORT` | No | Express listen port; defaults to `5000`. |
| `POSTGRES_PASSWORD` | For Compose | Password assigned to the local PostgreSQL container. Must match `DATABASE_URL`. |
| `DATABASE_URL` | Yes | PostgreSQL connection URI used by the API, worker, migration runner, and integration tests. |
| `REDIS_HOST` | No | Redis host; defaults to `127.0.0.1`. |
| `REDIS_PORT` | No | Redis port; defaults to `6379`. |
| `ELASTICSEARCH_URL` | No | Elasticsearch node URL; defaults to `http://127.0.0.1:9200`. Search/backfill is unavailable while Elasticsearch is down, but the API can still start. |
| `GOOGLE_CLIENT_ID` | Yes for API startup | Google OAuth 2.0 web-client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes for API startup | Google OAuth 2.0 web-client secret. |
| `GOOGLE_CALLBACK_URL` | Yes for API startup | OAuth callback; local default is `http://localhost:5000/api/auth/google/callback`. Register this exact URL in Google Cloud Console. |
| `FRONTEND_URL` | Yes for API startup | Frontend origin used after OAuth; local default is `http://localhost:5173`. |
| `SESSION_SECRET` | Yes for API startup | Private Express-session signing secret, at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. |
| `WORKER_CONCURRENCY` | No | Email worker concurrency; defaults to `2`, clamped to 1–50. |
| `SLACK_WORKER_CONCURRENCY` | No | Slack notification worker concurrency; defaults to `2`, clamped to 1–10. |
| `MAX_EMAILS_PER_SENDER_PER_HOUR` | No | Maximum sender reservations per rate-limit window; defaults to `100`. |
| `SENDER_RATE_LIMIT_WINDOW_MS` | No | Fixed sender limit window in milliseconds; defaults to one hour (`3600000`). |
| `MIN_EMAIL_DELAY_MS` | No | Minimum spacing between reservations for the same sender; defaults to `2000`. |
| `BULL_BOARD_USER` | Optional | Username for HTTP Basic Auth on `/admin/queues`. |
| `BULL_BOARD_PASSWORD` | Optional | Password for HTTP Basic Auth on `/admin/queues`. Both Bull Board values must be set to access the UI. |
| `SLACK_CLIENT_ID` | Only for Slack | Slack app client ID. |
| `SLACK_CLIENT_SECRET` | Only for Slack | Slack app client secret. |
| `SLACK_REDIRECT_URI` | Only for Slack | OAuth callback; local default is `http://localhost:5000/api/integrations/slack/callback`. Register it in Slack API settings. |
| `SLACK_WEBHOOK_ENCRYPTION_KEY` | Only for Slack | 32-byte key encoded as 64 hex characters. Generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Preserve it; changing it without re-encrypting stored webhooks makes existing connections unreadable. |
| `VITE_AUTH_API_ORIGIN` | Optional, client only | Backend origin used to start Google/Slack OAuth. The default is `http://localhost:5000` in development and the current origin otherwise. If overriding, copy `client/.env.example` to `client/.env.local`. |

If a PostgreSQL password contains URL-reserved characters, percent-encode it in `DATABASE_URL`.

### Google OAuth

Create a Google OAuth 2.0 **Web application**, add the local callback URL above as an authorized redirect URI, and enter the client ID/secret in `.env`. Use `localhost` consistently for the callback and browser URL; mixing `localhost` and `127.0.0.1` can prevent the session cookie from being sent on callback.

### Email provider

There are no SMTP environment variables in the current implementation. On worker startup, Nodemailer creates a test account with Ethereal and connects to Ethereal SMTP. Preview links are recorded with email log metadata, but the current frontend/API does not expose those log details as an inbox preview action. Ethereal is for testing and captures messages rather than delivering them to real inboxes.

Gmail SMTP / Gmail app-password delivery is **not implemented**. Do not add Gmail passwords to configuration or assume that changing `.env` switches the mail provider.

### Slack OAuth (optional)

Create a Slack app, add the `incoming-webhook` scope, register `SLACK_REDIRECT_URI`, install the app, and set the Slack variables above. Only the incoming webhook is persisted, encrypted with AES-256-GCM in PostgreSQL; it is not returned by the status API. Follow [SLACK_INTEGRATION.md](./SLACK_INTEGRATION.md) for workspace setup and a live notification demo.

## Start local services

Run these commands from the repository root in PowerShell:

```powershell
npm ci
npm --prefix client ci
Copy-Item .env.example .env
# Edit .env: set POSTGRES_PASSWORD and the matching DATABASE_URL password,
# Google OAuth values, FRONTEND_URL, and a strong SESSION_SECRET.
docker compose up -d
npm run db:migrate
```

The Compose file starts PostgreSQL 16, Redis 7, and Elasticsearch 9.5.6. PostgreSQL and Redis data use named Docker volumes; Redis is configured with AOF persistence. Do not run `docker compose down -v` if you need to preserve local database, Redis, or Elasticsearch data.

### Run the backend in development

Open separate PowerShell terminals at the project root:

```powershell
npm run dev
```

```powershell
npm run worker
```

The API listens at `http://localhost:5000`; the worker runs both the email-sending and Slack-notification BullMQ workers. Start the frontend separately as described below.

### Build and start the backend

```powershell
npm run typecheck
npm run build
npm start
```

In another terminal, start the compiled worker:

```powershell
npm run worker:start
```

Both compiled entry points load the root `.env`. The worker should run as a separate process from Express.

## Frontend setup

From the repository root:

```powershell
npm --prefix client run dev
```

Vite serves `http://localhost:5173` and proxies `/api` and `/health` to the backend at `http://localhost:5000`. If the backend origin differs, copy `client/.env.example` to `client/.env.local`, set `VITE_AUTH_API_ORIGIN`, and restart Vite.

Build the production frontend:

```powershell
npm --prefix client run build
```

The frontend build outputs static files to `client/dist`. Hosting those files in production is a deployment step not configured by this repository.

## Architecture and data flow

1. **Campaign creation:** `POST /api/campaigns` validates and stores the authenticated user's campaign in PostgreSQL. The frontend creates the campaign through `client/src/pages/Compose.tsx` and `client/src/services/api.ts`; backend handling is in `src/routes/campaign.routes.ts`.
2. **CSV lead import:** Compose parses CSV/text recipient data in the browser, then sends a normalized CSV to `POST /api/leads/import`. The API validates email rows and inserts user-owned leads and campaign email records transactionally. See `src/routes/lead.routes.ts`.
3. **Scheduled email persistence:** `scheduled_emails` rows store recipient, message, schedule time, status, attempts, and stable idempotency/BullMQ identifiers. PostgreSQL migrations are under `src/db/migrations/`.
4. **BullMQ scheduling:** `POST /api/campaigns/:id/schedule` reads pending records in batches of 100 and bulk-enqueues stable `email-<id>` job IDs. BullMQ uses Redis; the route is `src/routes/scheduler.routes.ts` and queue setup is `src/queue/email.queue.ts`.
5. **Restart persistence:** PostgreSQL is the source of truth for email records. BullMQ job data and delayed state are stored in Redis; Compose enables Redis AOF and named volumes for Redis and PostgreSQL. Application and worker restarts do not intentionally clear those stores. Redis process/data loss is outside what application-level persistence alone can protect against.
6. **Sender rate limits:** `src/services/rate-limiter.service.ts` runs an atomic Redis Lua reservation with a sender-specific key and a fixed window. A capacity-denied job is returned to the BullMQ delayed set by `src/workers/email.worker.ts`; it is not marked sent or permanently failed. The key is based on email account ID when present; campaigns without an account use a shared Ethereal fallback sender key.
7. **Minimum delay:** Campaign `minimum_delay_seconds` staggers jobs at scheduling time. Redis also enforces the configured `MIN_EMAIL_DELAY_MS` minimum between sender reservations across jobs/workers.
8. **Concurrency:** `WORKER_CONCURRENCY` bounds the email worker (default 2; 1–50); `SLACK_WORKER_CONCURRENCY` bounds the separate Slack notification worker (default 2; 1–10).
9. **Duplicate prevention:** Stable BullMQ job IDs avoid duplicate queue entries for the same email. The worker atomically claims only PostgreSQL rows in `pending` or `queued` state before reserving sender capacity, so normal duplicate job deliveries cannot claim or send the same record twice.
10. **Failures and retries:** Email queue jobs have three attempts with exponential backoff starting at five seconds. The worker updates scheduled-email status and logs; after retries are exhausted, the record is marked failed. SMTP cannot provide an exactly-once guarantee: if SMTP accepts a message and the process crashes before PostgreSQL records `sent`, that uncertain record is not blindly resent.
11. **Search:** `src/services/email-search.service.ts` indexes sent-message documents in Elasticsearch using email ID as document ID. Startup attempts to create/verify mappings and backfill up to 1,000 sent records. Elasticsearch failure is logged and does not prevent the core API from starting; search then is unavailable.
12. **Slack alerts:** When a sender hits its configured fixed-window capacity, the rate limiter deduplicates an alert per tenant/sender/window in Redis and enqueues it on `slack-notifications`. The worker fetches the current active integration from PostgreSQL, decrypts its webhook, and posts to Slack. Slack failures are retried separately and do not fail email jobs.

## Backend and frontend feature details

### Backend

- Campaign creation and per-user campaign listing/detail.
- Lead listing and CSV import with validation and duplicate handling.
- Scheduled email persistence and batched BullMQ scheduling.
- Redis sender rate limiting, configurable minimum delay, bounded worker concurrency.
- Ethereal SMTP test sending, retries, status tracking, and email event logs.
- PostgreSQL-backed Google OAuth sessions and authenticated APIs.
- Optional Slack connection status, connect, reconnect, disconnect, and rate-limit notifications.
- Elasticsearch search for sent emails.
- Bull Board queue dashboard protected by optional HTTP Basic Auth.

### Frontend

- Google login; email/password sign-in is not provided.
- Workspace dashboard, campaign and lead views.
- Scheduled and Sent inboxes, message details, and sent-email search.
- Compose with manual recipients or CSV/text import, subject/body, future schedule time, and campaign delay.
- Slack integration status and controls.
- Queue page with database health check and link to Bull Board; it does not expose a worker heartbeat endpoint.

## Assumptions, trade-offs, and limitations

- Ethereal is the implemented development transport. A “sent” status means accepted by Ethereal SMTP, not delivered to a real inbox.
- Gmail SMTP and Gmail app-password support are not implemented. The schema contains email-account fields, but this application does not provide an email-account management/configuration UI; the current worker sends through its Ethereal test transport.
- The Compose PostgreSQL password must be supplied through `.env`; `.env.example` contains only an obvious placeholder.
- `MAX_EMAILS_PER_HOUR` and `DEV_USER_ID`, if present in older local environment files, are not read by the current application. Use `MAX_EMAILS_PER_SENDER_PER_HOUR`; no development authentication bypass is implemented.
- Rate limiting uses an aligned fixed time window, not a rolling/sliding window. The no-account Ethereal fallback uses a shared sender key.
- Rich-text formatting and attachments are not delivered. The compose UI blocks submitting messages with attachments.
- Personalization placeholders are not expanded by the worker.
- Elasticsearch backfill is limited to the most recent 1,000 sent records.
- There is no configured production static hosting/deployment, automated client test runner, or worker heartbeat API.
- Queue and database records are durable under the configured storage/persistence settings; backups and recovery from storage loss remain an operator responsibility.

## Tests and verification commands

Run backend type checking and builds:

```powershell
npm run typecheck
npm run build
npm --prefix client run build
```

The backend test scripts and their service requirements are:

| Command | Coverage | Requirements |
|---|---|---|
| `npm run test:auth` | Google OAuth route/session behavior with test dependencies | No external services |
| `npm run test:auth:db` | Google identity persistence and linking | PostgreSQL (`.env`) |
| `npm run test:auth:api` | Authenticated API ownership/isolation | PostgreSQL, Redis, Elasticsearch (`.env`) |
| `npm run test:slack` | Slack OAuth state and callback route behavior | No external services |
| `npm run test:slack:db` | Encrypted Slack persistence and mocked webhook outcomes | PostgreSQL (`.env`) |
| `npm run test:rate-limiter` | Concurrent Redis sender reservations and notification dedupe | PostgreSQL, Redis (`.env`) |
| `npm run test:api-rate-limit` | Redis-backed API request limiter | Redis (`.env`) |
| `npm run test:scheduler:bulk` | Isolated scheduling/persistence/queue test; does not start email worker | PostgreSQL, Redis (`.env`) |

The database-backed tests create and clean isolated fixture records. They do not perform bulk real email delivery. Automated Slack webhook cases use mocked responses. A live Slack delivery and a real Google sign-in require external workspace/account consent and must be demonstrated separately.

The bulk scheduler test defaults to 1,005 synthetic jobs. To choose another fixture size for an isolated run:

```powershell
$env:BULK_TEST_EMAIL_COUNT = "5000"
npm run test:scheduler:bulk
Remove-Item Env:BULK_TEST_EMAIL_COUNT
```

This test schedules jobs in PostgreSQL/Redis but deliberately does not start the email worker or send messages.

## Repository hygiene

- Install from the committed lockfiles with `npm ci` and `npm --prefix client ci`.
- `.gitignore` excludes environment files, dependency directories, build outputs, TypeScript build metadata, private certificate/key files, and local QA recipient CSVs.
- Keep `.env`, `client/.env.local`, OAuth client secrets, session secrets, Slack webhook encryption keys, and any real recipient data out of Git.
- Review `git status --ignored --short` and `git diff --cached --name-only` before committing. This workspace may be a folder without Git metadata; initialize/use a repository only when you choose to.

## Related documentation

- [Slack integration and live demo guide](./SLACK_INTEGRATION.md)
