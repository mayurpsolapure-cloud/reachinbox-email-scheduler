# ReachInbox frontend

The React/Vite app uses the existing backend through the Vite development proxy. The workspace provides compact Scheduled and Sent inboxes, a message detail view, and Compose New Email.

For complete project setup, environment variables, architecture, and test commands, see the repository [README](../README.md).

## Run locally

Start the backend dependencies and API using the repository instructions. From the repository root, the client can be run with:

```powershell
npm --prefix client ci
npm --prefix client run dev
```

Vite serves `http://localhost:5173` and proxies `/api` and `/health` to `http://localhost:5000`. Check the production TypeScript build with `npm --prefix client run build`.

## Authentication setup

Configure these values in the existing backend `.env` (do not commit that file):

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback
FRONTEND_URL=http://localhost:5173
SESSION_SECRET=
```

In Google Cloud Console, configure an OAuth 2.0 Web application with the callback URL above as an authorized redirect URI. Generate a strong session secret, for example with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. The server validates required configuration at startup.

Run database migrations before starting the API; migration `002_google_auth.sql` adds the Google subject and avatar columns and preserves legacy Google identity data:

```powershell
npm run db:migrate
npm run dev
```

The browser is redirected through the backend OAuth authorization-code flow. Google ID tokens are verified server-side and never sent to or stored in browser storage. Authenticated API requests use the HttpOnly PostgreSQL-backed session cookie.

The Google sign-in button starts OAuth directly on the backend origin so the session cookie hostname matches `GOOGLE_CALLBACK_URL`. Local development defaults to `http://localhost:5000`; if the backend is elsewhere, set both `VITE_AUTH_API_ORIGIN` and `VITE_API_BASE_URL` in `client/.env.local`, then restart Vite. Use the same hostname consistently in the callback URL and frontend URL (for example, do not mix `localhost` and `127.0.0.1`).

Run authentication checks with:

```powershell
npm run test:auth
npm run test:auth:db
npm run test:auth:api
```

The route tests use an injected provider to cover failure and session handling. The database and API suites need the configured local PostgreSQL, Redis, and Elasticsearch services. A real Google sign-in additionally requires valid Google Cloud OAuth credentials and an authorized callback URI.

## Integrated backend routes

- `GET /api/auth/google`, `GET /api/auth/google/callback`
- `GET /api/auth/me`, `POST /api/auth/logout`

- `GET /api/campaigns`, `GET /api/campaigns/:id`, `GET /api/campaigns/:id/emails`
- `POST /api/campaigns`
- `POST /api/campaigns/:id/schedule`
- `GET /api/leads?page=&limit=`
- `POST /api/leads/import` (multipart field `file`, optional `campaignId`)
- `GET /api/search/emails?q=`
- `GET /health/db`
- `GET /api/integrations/slack/connect`, `GET /api/integrations/slack/callback`
- `GET /api/integrations/slack/status`, `DELETE /api/integrations/slack/disconnect`

Compose creates a campaign, imports the validated unique recipient addresses using the campaign ID, then queues it through the schedule endpoint. CSV/text recipient parsing and duplicate counts happen in the browser; the backend receives a normalized CSV email column.

## Backend limitations

- There is no global email-list API. The inboxes aggregate per-campaign email responses.
- Per-campaign hourly limits, attachments, favorites, archive, and delete operations are unsupported. Attachment submission is blocked and unavailable actions are not simulated. The sender hourly limit is backend-managed.
- The backend sends plain-text email bodies. Rich formatting and attachments are not delivered.
- Sent status indicates acceptance by the Gmail API, not delivery to a recipient's actual inbox.
- The backend currently sends campaign personalization tokens literally; it does not replace `{{first_name}}`, `{{last_name}}`, or `{{company}}`.

Slack OAuth setup, rate-limit alert behavior, and live-demo steps are documented in the repository's [Slack integration guide](../SLACK_INTEGRATION.md).
