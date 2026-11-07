# ReachInbox

ReachInbox is a development email-campaign scheduler with a React dashboard. It imports recipient lists, persists scheduled email records in PostgreSQL, queues delivery jobs through BullMQ/Redis, and provides Google sign-in, sent-email search, and optional Slack alerts when a sender limit is reached.

> Scheduled email is sent through the Gmail API using the Google account authorized by the ReachInbox user. Gmail API acceptance does not guarantee delivery to the recipient's inbox.

## Features

### Backend

- Google OAuth 2.0 login with verified Google identity, PostgreSQL-backed Express sessions, and authenticated, user-scoped campaign and lead APIs.
- Campaign creation, CSV lead import, and PostgreSQL persistence for scheduled email records.
- Batched scheduling into BullMQ with stable job IDs, backed by Redis persistence.
- Per-sender fixed-window capacity limits, minimum send spacing, and bounded worker concurrency.
- Gmail API sending with encrypted per-user refresh tokens, automatic access-token refresh, BullMQ retries, and message-id persistence.
- Elasticsearch search over sent messages.
- Optional Slack OAuth connection using incoming webhooks encrypted at rest; rate-limit alerts are sent by a separate Slack notification worker.
- Authenticated Bull Board queue UI at `/admin/queues` when credentials are configured.

### Frontend

- Google sign-in and session-aware dashboard.
- Gmail authorization and reconnect status in Settings.
- Dashboard, campaigns, leads, Scheduled and Sent email views, email details, search, and a queue/health page.
- Compose flow with recipient entry, CSV/text parsing, duplicate/invalid counts, subject/body, scheduled time, and minimum delay controls.
- Slack connect, status, reconnect, and disconnect controls.

## Technology

- Frontend: React 18, TypeScript, Vite, Tailwind CSS 4, React Router.
- Backend: Node.js, TypeScript, Express 5.
- Persistence and queue: PostgreSQL, Redis, BullMQ.
- Mail and search: Google Gmail API, Elasticsearch.
- Integrations: Google OAuth 2.0 and Slack OAuth 2.0 / Incoming Webhooks.

## Prerequisites

- Node.js 22.9 or newer (Node.js 22 LTS recommended) and npm.
- Docker Desktop with Docker Compose.
- Google OAuth web-client credentials, Gmail API enabled, and Gmail sending scope approved for interactive sign-in and sending.
- A Slack app/workspace only if demonstrating live Slack integration.
- At least 4 GB memory available to Docker is recommended; the Elasticsearch container is configured with a 1 GB limit.

PostgreSQL, Redis, and Elasticsearch are provided by the repository's Docker Compose configuration. You may instead run compatible local services and adjust the environment variables.

## Configure environment

From the project root, create a private local environment file:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
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
| `REDIS_URL` | Production | Redis connection URL, including Railway's private URL. Takes precedence over `REDIS_HOST`/`REDIS_PORT`. |
| `ELASTICSEARCH_URL` | Yes for production API | Elasticsearch node URL; local default is `http://127.0.0.1:9200`. Production API startup/readiness fails if search is unavailable. |
| `ELASTICSEARCH_USERNAME` | Optional | Elasticsearch basic-auth username when required by the hosted cluster. |
| `ELASTICSEARCH_PASSWORD` | Optional | Elasticsearch basic-auth password. |
| `ELASTICSEARCH_API_KEY` | Optional | Elasticsearch API key; preferred over username/password when available. |
| `GOOGLE_CLIENT_ID` | Yes for API startup | Google OAuth 2.0 web-client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes for API startup | Google OAuth 2.0 web-client secret. |
| `GOOGLE_CALLBACK_URL` | Yes for API startup | OAuth callback; local default is `http://localhost:5000/api/auth/google/callback`. Register this exact URL in Google Cloud Console. |
| `GOOGLE_GMAIL_CALLBACK_URL` | Yes for API startup | Gmail reconnect callback; local default is `http://localhost:5000/api/integrations/gmail/callback`. Register this exact URL in Google Cloud Console. |
| `FRONTEND_URL` | Yes for API startup | Frontend origin used after OAuth; local default is `http://localhost:5173`. |
| `SESSION_SECRET` | Yes for API startup | Private Express-session signing secret, at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Yes for API startup and worker | 32-byte AES-256-GCM key encoded as 64 hex characters. Generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it stable and secret; changing it makes stored Gmail refresh tokens unreadable. |
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
| `VITE_AUTH_API_ORIGIN` | Optional, client build | Backend origin used to start Google/Slack OAuth. Set to the backend public HTTPS origin when frontend and backend have separate domains. |
| `VITE_API_BASE_URL` | Optional, client build | API base URL; defaults to `/api` for same-origin hosting. For separate Railway services, set the backend public HTTPS URL with `/api`. |

If a PostgreSQL password contains URL-reserved characters, percent-encode it in `DATABASE_URL`.

### Google OAuth and Gmail sending

In Google Cloud Console, enable the **Gmail API**, configure the OAuth consent screen, and create a Google OAuth 2.0 **Web application** client. Request the `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.send` scopes. Add both `GOOGLE_CALLBACK_URL` and `GOOGLE_GMAIL_CALLBACK_URL` as authorized redirect URIs, and enter the client ID/secret in `.env`. The OAuth consent screen may require test users or Google verification depending on the project's publishing status and scope use.

Use `localhost` consistently for the callback and browser URL; mixing `localhost` and `127.0.0.1` can prevent the session cookie from being sent on callback. The first sign-in requests Gmail permission. Previously signed-in accounts without a refresh token can authorize or reconnect from **Settings**. ReachInbox only returns the connected Gmail address and status to the browser; OAuth tokens remain server-side.

Refresh tokens are encrypted with AES-256-GCM in PostgreSQL. Back up `GMAIL_TOKEN_ENCRYPTION_KEY` securely and preserve it across deploys. Never configure a Gmail password or App Password.

### Slack OAuth (optional)

Create a Slack app, add the `incoming-webhook` scope, register `SLACK_REDIRECT_URI`, install the app, and set the Slack variables above. Only the incoming webhook is persisted, encrypted with AES-256-GCM in PostgreSQL; it is not returned by the status API. Follow [SLACK_INTEGRATION.md](./SLACK_INTEGRATION.md) for workspace setup and a live notification demo.

## Start local services

Run these commands from the repository root in PowerShell:

```powershell
npm ci
npm --prefix client ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env: set POSTGRES_PASSWORD and the matching DATABASE_URL password,
# both Google callback URLs, Google OAuth credentials, FRONTEND_URL,
# SESSION_SECRET, and GMAIL_TOKEN_ENCRYPTION_KEY.
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
6. **Sender rate limits:** `src/services/rate-limiter.service.ts` runs an atomic Redis Lua reservation with a per-user Gmail sender key and fixed window. A capacity-denied job is returned to the BullMQ delayed set; it is not marked sent or permanently failed.
7. **Minimum delay:** Campaign `minimum_delay_seconds` staggers jobs at scheduling time. Redis also enforces the configured `MIN_EMAIL_DELAY_MS` minimum between sender reservations across jobs/workers.
8. **Concurrency:** `WORKER_CONCURRENCY` bounds the email worker (default 2; 1–50); `SLACK_WORKER_CONCURRENCY` bounds the separate Slack notification worker (default 2; 1–10).
9. **Duplicate prevention:** Stable BullMQ job IDs avoid duplicate queue entries for the same email. The worker atomically claims only PostgreSQL rows in `pending` or `queued` state before reserving sender capacity, so normal duplicate job deliveries cannot claim or send the same record twice.
10. **Failures and retries:** Email queue jobs have three attempts with exponential backoff starting at five seconds. A per-email database send-attempt marker prevents a second Gmail API call after an ambiguous response. Explicit quota rejections (429) can be retried; if Gmail may have accepted a message but the response is lost, the record is held for manual verification rather than risking a duplicate. Gmail API acceptance still does not guarantee final inbox delivery.
11. **Search:** `src/services/email-search.service.ts` indexes sent-message documents in Elasticsearch using email ID as document ID. Startup attempts to create/verify mappings and backfill up to 1,000 sent records. Elasticsearch failure is logged and does not prevent the core API from starting; search then is unavailable.
12. **Slack alerts:** When a sender hits its configured fixed-window capacity, the rate limiter deduplicates an alert per tenant/sender/window in Redis and enqueues it on `slack-notifications`. The worker fetches the current active integration from PostgreSQL, decrypts its webhook, and posts to Slack. Slack failures are retried separately and do not fail email jobs.

## Backend and frontend feature details

### Backend

- Campaign creation and per-user campaign listing/detail.
- Lead listing and CSV import with validation and duplicate handling.
- Scheduled email persistence and batched BullMQ scheduling.
- Redis sender rate limiting, configurable minimum delay, bounded worker concurrency.
- Gmail API sending from each user's authorized Google account, refresh-token encryption, retries, status tracking, and email event logs.
- PostgreSQL-backed Google OAuth sessions and authenticated APIs.
- Optional Slack connection status, connect, reconnect, disconnect, and rate-limit notifications.
- Elasticsearch search for sent emails.
- Bull Board queue dashboard protected by optional HTTP Basic Auth.

### Frontend

- Google login; email/password sign-in is not provided.
- Workspace dashboard, campaign and lead views.
- Scheduled and Sent inboxes, message details, and sent-email search.
- Compose with manual recipients or CSV/text import, subject/body, future schedule time, and campaign delay.
- Gmail authorization/reconnect and Slack integration status and controls.
- Queue page with backend dependency readiness and a link to Bull Board; it does not expose a worker heartbeat endpoint.

## Assumptions, trade-offs, and limitations

- A “sent” status means Gmail API accepted the request; it does not confirm final inbox delivery.
- Gmail API does not provide a general exactly-once send guarantee. The worker records an attempt before calling Gmail and will not submit the same scheduled email again after an ambiguous result. Verify the Gmail Sent folder before manually rescheduling an email whose outcome is unknown.
- The Compose PostgreSQL password must be supplied through `.env`; `.env.example` contains only an obvious placeholder.
- `MAX_EMAILS_PER_HOUR` and `DEV_USER_ID`, if present in older local environment files, are not read by the current application. Use `MAX_EMAILS_PER_SENDER_PER_HOUR`; no development authentication bypass is implemented.
- Rate limiting uses an aligned fixed time window, not a rolling/sliding window. Each user's Gmail account has its own sender key.
- Rich-text formatting and attachments are not delivered. The compose UI blocks submitting messages with attachments.
- Personalization placeholders are not expanded by the worker.
- Elasticsearch backfill is limited to the most recent 1,000 sent records.
- There is no automated client test runner or worker heartbeat API.
- Production API and frontend can use separate HTTPS domains; configure exact-origin credentialed CORS and `VITE_API_BASE_URL`/`VITE_AUTH_API_ORIGIN` at client build time.
- Queue and database records are durable under the configured storage/persistence settings; backups and recovery from storage loss remain an operator responsibility.

## Deployment notes

Before deploying, provision PostgreSQL and Redis, run `npm ci` and `npm --prefix client ci`, and apply migrations with `npm run db:migrate`. Set all required variables in the deployment secret manager, especially both HTTPS Google callback URLs, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, and a durable `GMAIL_TOKEN_ENCRYPTION_KEY`. Set the same encryption key for the API and worker and back it up securely. Do not copy local `.env` files into source control.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the service-by-service Railway setup. Production session cookies are `Secure`, `HttpOnly`, and `SameSite=None`; the API allows credentialed CORS only from the exact `FRONTEND_URL` origin. Serve both services over HTTPS.

Register both deployed callback URLs in the Google Cloud OAuth client:

- `https://YOUR_API_HOST/api/auth/google/callback`
- `https://YOUR_API_HOST/api/integrations/gmail/callback`

Complete the Google consent-screen publishing/verification requirements for the Gmail sending scope. No real Gmail send has been performed by the automated test suite.

### Real Gmail sending check

1. Enable Gmail API and register both exact redirect URIs in Google Cloud. If the OAuth consent screen is in Testing, add the Google account as a test user.
2. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, both callback URLs, `SESSION_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, and database/Redis configuration in the private `.env`.
3. Apply migrations with `npm run db:migrate`; start PostgreSQL/Redis/Elasticsearch, then run `npm run dev`, `npm run worker`, and `npm --prefix client run dev` in separate terminals.
4. Sign in with the intended Google account. Open **Settings → Authorize Gmail** and approve the Gmail sending permission. Confirm the connected email shown in Settings is the expected sender.
5. Compose one test message addressed to an inbox you control, schedule it a few minutes ahead (or now), and wait for the worker. Confirm the message appears in the sender's Gmail **Sent** folder and check the recipient inbox separately.

This is the only real-send verification. The automated tests mock Gmail API responses. Even after the message appears in Gmail Sent, API acceptance is not a guarantee of final recipient inbox delivery.

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
| `npm run test:gmail` | Gmail OAuth consent, encrypted token handling, MIME, identity isolation, and mocked send/retry behavior | No external services; Gmail API is mocked |
| `npm run test:gmail:db` | Encrypted Gmail refresh-token persistence, user separation, and reconnect state | PostgreSQL (`.env`) |
| `npm run test:auth:db` | Google identity persistence and linking | PostgreSQL (`.env`) |
| `npm run test:auth:api` | Authenticated API ownership/isolation | PostgreSQL, Redis, Elasticsearch (`.env`) |
| `npm run test:slack` | Slack OAuth state and callback route behavior | No external services |
| `npm run test:slack:db` | Encrypted Slack persistence and mocked webhook outcomes | PostgreSQL (`.env`) |
| `npm run test:rate-limiter` | Concurrent Redis sender reservations and notification dedupe | PostgreSQL, Redis (`.env`) |
| `npm run test:api-rate-limit` | Redis-backed API request limiter | Redis (`.env`) |
| `npm run test:scheduler:bulk` | Isolated scheduling/persistence/queue test; does not start email worker | PostgreSQL, Redis (`.env`) |

The database-backed tests create and clean isolated fixture records. Automated Gmail and Slack API cases use mocks and do not send real email. A real Gmail sending check must be performed separately with a test Google account and recipient consent.

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
