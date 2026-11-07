# Railway deployment guide

This repository is prepared for separate Railway services. This guide describes configuration only; it does not create Railway resources, migrate a remote database, or deploy the application.

The backend and worker share the root package/build. The frontend is an isolated app under `client/`. Use Railway's dashboard to configure each service individually. Do not use a `railway.json`/`railway.toml` config-as-code file for this deployment: Railway has deprecated that format and its published cutoff is 2026-12-01. Avoid applying an IaC file that might create a new database or replace an existing service. If a database already contains ReachInbox data, attach that same service and its `DATABASE_URL`.

## Service matrix

| Railway service | Source root directory | Build command | Start / pre-deploy command | Public domain |
|---|---|---|---|---|
| `frontend` | `/client` | `npm ci && npm run build` | Start: `npm start` | Yes, HTTPS |
| `backend` | `/` (repository root) | `npm ci --include=dev && npm run build` | Pre-deploy: `npm run db:migrate:compiled`; Start: `npm start` | Yes, HTTPS |
| `worker` | `/` (repository root) | `npm ci --include=dev && npm run build` | Start: `npm run worker:start` | **No** |
| `postgres` | Railway PostgreSQL service | Managed service | Managed by Railway | **No** |
| `redis` | Railway Redis service | Managed service | Managed by Railway | **No** |
| `elasticsearch` | Managed Elasticsearch, or a separately configured private Elasticsearch service | Provider-specific | Provider-specific | **No public endpoint for self-hosted ES** |

Use the Node version from the root `engines.node` requirement (`>=22.9.0`). The app listens on Railway's injected `PORT`; Express and the frontend static server bind to `0.0.0.0`.

## 1. Preserve and connect data services

1. In the intended Railway project/environment, inspect existing PostgreSQL and Redis services before adding anything.
2. If PostgreSQL already contains ReachInbox data, use that existing service. Do **not** click Add PostgreSQL to make a replacement. Preserve its volume and backups.
3. If there is no existing PostgreSQL, create a Railway PostgreSQL service and retain its generated persistent volume.
4. Create or select one Redis service with persistence suitable for BullMQ delayed jobs. Do not expose its TCP port publicly.
5. In Railway Variables, reference service variables rather than copying credentials into source:
   - Backend and worker `DATABASE_URL`: `${{postgres.DATABASE_URL}}` (use the actual existing PostgreSQL service name).
   - Backend and worker `REDIS_URL`: `${{redis.REDIS_URL}}` (use the actual Redis service name and confirm it is the private-network URL).
6. Confirm both service references resolve in Railway's private network. Do not paste either value into chat, Git, or deployment documentation.

The existing migration runner records applied migration names in `schema_migrations`. The Railway backend pre-deploy command runs the compiled form of that same migration system. Migration `004_gmail_authorizations.sql` only adds authorization/send-tracking fields; it does not drop existing user, campaign, or email data.

## 2. Elasticsearch/search

`ELASTICSEARCH_URL` is mandatory for a production backend. Backend startup and `/health/ready` fail when Elasticsearch is unreachable; search is not silently disabled.

**Recommended:** use a managed Elasticsearch deployment (for example Elastic Cloud), restricted to the backend/worker network where possible. Set its HTTPS endpoint in `ELASTICSEARCH_URL` and credentials in `ELASTICSEARCH_API_KEY`, or use `ELASTICSEARCH_USERNAME` and `ELASTICSEARCH_PASSWORD`. Do not put credentials in the URL or frontend variables.

If self-hosting Elasticsearch as a Railway service:

- Pin the image to the project's compatible Elasticsearch release (`docker.elastic.co/elasticsearch/elasticsearch:9.5.6` is used by local Compose).
- Set single-node discovery, configure authentication, and attach a persistent Railway volume at `/usr/share/elasticsearch/data`.
- Keep it on Railway private networking only. Never enable a public domain for Elasticsearch or disable authentication on a publicly reachable endpoint.
- Allocate at least 4 GiB RAM to the service as a starting point (including JVM/native overhead), set a JVM heap appropriate to the plan (for example 1–2 GiB), and budget persistent disk for the index plus growth. Monitor heap, disk, and container restarts; take snapshots/backups separately.
- Verify the Railway plan permits the memory, storage, and kernel settings Elasticsearch requires before choosing this option. For a small Railway plan, managed Elasticsearch is more practical.

Set `ELASTICSEARCH_URL` on both backend and worker if worker-side indexing/search helpers require it. Set the same optional Elasticsearch authentication variables on both services.

## 3. Create and configure `backend`

1. Add a GitHub service from this repository named `backend`.
2. Set **Root Directory** to `/`.
3. Set the build command to `npm ci --include=dev && npm run build`.
4. Set the **Pre-deploy Command** to `npm run db:migrate:compiled`. Set a reasonable migration timeout; let a failed migration fail the deployment.
5. Set the start command to `npm start`.
6. Add a public domain and force HTTPS. Do not expose PostgreSQL, Redis, or Elasticsearch.
7. Set the Railway health check path to `/health/ready`. This endpoint returns 200 only when PostgreSQL, Redis, and Elasticsearch are reachable; `/health/live` is a dependency-independent liveness endpoint. Allow a suitable startup/grace interval for connections and the initial Elasticsearch backfill; do not weaken readiness by making it report healthy while a dependency is unavailable.
8. Configure these service variables (use Railway references for the database and Redis):

   **Required**

   - `NODE_ENV=production`
   - `DATABASE_URL=${{postgres.DATABASE_URL}}`
   - `REDIS_URL=${{redis.REDIS_URL}}`
   - `ELASTICSEARCH_URL=<private HTTPS URL or managed cluster URL>`
   - `GOOGLE_CLIENT_ID=<OAuth web client ID>`
   - `GOOGLE_CLIENT_SECRET=<OAuth web client secret>`
   - `GOOGLE_CALLBACK_URL=https://<backend-domain>/api/auth/google/callback`
   - `GOOGLE_GMAIL_CALLBACK_URL=https://<backend-domain>/api/integrations/gmail/callback`
   - `FRONTEND_URL=https://<frontend-domain>` (origin only, no path/trailing route)
   - `SESSION_SECRET=<random secret, at least 32 characters>`
   - `GMAIL_TOKEN_ENCRYPTION_KEY=<32 random bytes, 64 hex characters>`

   **Optional**

   - `ELASTICSEARCH_API_KEY` **or** `ELASTICSEARCH_USERNAME` and `ELASTICSEARCH_PASSWORD`
   - `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI=https://<backend-domain>/api/integrations/slack/callback`, and `SLACK_WEBHOOK_ENCRYPTION_KEY`
   - `MAX_EMAILS_PER_SENDER_PER_HOUR`, `SENDER_RATE_LIMIT_WINDOW_MS`, `MIN_EMAIL_DELAY_MS`
   - `BULL_BOARD_USER` and `BULL_BOARD_PASSWORD` if Bull Board should be accessible

Use Railway's generated `PORT`; do not hardcode it. `SESSION_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, Slack credentials/keys, and Elasticsearch credentials belong only in Railway's encrypted service variables. Keep Gmail/Slack encryption keys stable across deployments and backups.

## 4. Create and configure `worker`

1. Add a second GitHub service from the same repository named `worker`.
2. Set **Root Directory** to `/`.
3. Set build command to `npm ci --include=dev && npm run build`.
4. Set start command to `npm run worker:start`.
5. Do not assign a public domain or expose a port.
6. Set **replicas/instances to 1**. Do not create a second worker service for this queue. BullMQ and database claims protect concurrent job handling, but running extra processes wastes capacity and complicates operations.
7. Add the same required `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GMAIL_TOKEN_ENCRYPTION_KEY` references/values used by backend. Add Elasticsearch auth values if configured, plus `WORKER_CONCURRENCY`, `SLACK_WORKER_CONCURRENCY`, and rate-limit variables as needed.
8. Set Slack OAuth/encryption variables if Slack notifications are enabled.

Do not set a migration pre-deploy command on the worker. Deploy backend migrations first; then deploy/redeploy the worker. Verify the worker's Railway logs show both email and Slack notification workers running. The worker has no public health URL; use its deployment state/logs and Bull Board for operational checks.

## 5. Create and configure `frontend`

1. Add a GitHub service from this repository named `frontend`.
2. Set **Root Directory** to `/client`.
3. Set build command to `npm ci && npm run build`.
4. Set start command to `npm start`. This runs `client/server.mjs`, which serves `dist/` on `0.0.0.0:$PORT` and falls back to `index.html` for SPA routes.
5. Add a public domain and force HTTPS.
6. Set its health check path to `/health/live`.
7. Set these **build-time** variables before building (Vite embeds them into public frontend assets):

   - `VITE_API_BASE_URL=https://<backend-domain>/api`
   - `VITE_AUTH_API_ORIGIN=https://<backend-domain>`

   Only URLs belong in `VITE_*` variables. Never put OAuth secrets, database URLs, session secrets, or token-encryption keys in frontend variables.

The frontend's API requests use `credentials: "include"`. `VITE_API_BASE_URL` must be HTTPS in a production build. After changing either frontend variable, trigger a new frontend deployment so Vite rebuilds the assets.

## 6. Google OAuth, Gmail, and Slack production URLs

After Railway assigns the frontend and backend domains, update Google Cloud Console's OAuth Web application:

- Authorized JavaScript origin: `https://<frontend-domain>`
- Authorized redirect URI: `https://<backend-domain>/api/auth/google/callback`
- Authorized redirect URI: `https://<backend-domain>/api/integrations/gmail/callback`
- Keep scopes `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/gmail.send`.
- Publish/configure the consent screen and add tester accounts if the app remains in testing.
- Enable Gmail API for the Google Cloud project.

For Slack OAuth, set `SLACK_REDIRECT_URI` to `https://<backend-domain>/api/integrations/slack/callback` and register that exact callback in the Slack app settings.

The backend only allows credentialed CORS from the exact `FRONTEND_URL`. Production session cookies are `Secure`, `HttpOnly`, and `SameSite=None` so separate HTTPS frontend/backend origins can use the PostgreSQL-backed session. Prefer frontend and API custom domains under the same registrable domain; browser third-party-cookie restrictions can interfere with unrelated domains.

## 7. Deployment order and smoke checks

1. Back up the existing database before the first production migration.
2. Configure PostgreSQL/Redis/Elasticsearch and private references.
3. Deploy `backend`; confirm the pre-deploy migration succeeds and `/health/ready` returns 200.
4. Deploy `worker` with one replica and no domain; inspect startup logs.
5. Deploy `frontend` with the backend HTTPS URL variables.
6. Open the frontend over HTTPS, complete Google login, and authorize Gmail under Settings. Confirm the displayed Gmail address is expected.
7. Use a test campaign and a recipient inbox you control. Confirm the message appears in the sender Gmail Sent folder and separately check recipient inbox. API acceptance is not a guarantee of final inbox delivery.
8. Test Slack connect/notification only if its production app and secret variables are configured.
9. Confirm `/health/ready` shows PostgreSQL, Redis, and Elasticsearch ready. Use the backend Railway domain for `/health/live` and `/health/ready`; use Bull Board with authentication for queue inspection.

## Backups and rollback

- Before migrations or a major release, create/verify a Railway PostgreSQL backup or snapshot from the PostgreSQL service's Backups page. Confirm restore access and retention before relying on it.
- For an additional portable backup, use `pg_dump` against the existing Railway `DATABASE_URL` from an authorized workstation or one-off job. Keep the dump encrypted and out of the repository/logs; never paste the connection URL into chat.
- Preserve PostgreSQL, Redis, and Elasticsearch volumes. Do not remove/recreate services or volumes to roll back application code.
- If an application release fails, redeploy the last known-good backend, worker, and frontend deployments. If a pre-deploy migration fails, Railway should stop that deployment; inspect the migration logs and database before retrying.
- Migration `004` is additive. Do not manually drop its table/columns during rollback; older application code can leave the additive schema unused. Keep app versions compatible with the database and stop the worker before any manual data repair.
- Restore a database backup only as an explicit recovery operation after confirming the target and data-loss window. A restore may discard writes made after that backup.

## Git and secrets checklist

- `.env` and `.env.*` are ignored, with only example templates allowed. Verify `git status --short -- .env` is empty and `git check-ignore .env` matches before pushing.
- Do not commit copied Railway variables or secret exports. `.env.example` contains placeholders, not real secrets.
- PostgreSQL, Redis, and self-hosted Elasticsearch have no public domains. Only frontend and backend need public HTTPS domains.
- Do not deploy until the production OAuth callbacks, encryption keys, private service references, and a database backup are confirmed.
