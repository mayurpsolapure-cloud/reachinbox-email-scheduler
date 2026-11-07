# Slack rate-limit notifications

ReachInbox connects one Slack Incoming Webhook per authenticated user (the current tenant boundary). The OAuth access token is not persisted. Only the webhook URL is retained, encrypted with AES-256-GCM in PostgreSQL. Slack credentials and webhook URLs are never returned by the status API.

## Configure a Slack app

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) and choose the workspace used for the demo.
2. Under **OAuth & Permissions**, add the redirect URL exactly as configured by `SLACK_REDIRECT_URI`. For local development, this is `http://localhost:5000/api/integrations/slack/callback`.
3. Add the `incoming-webhook` bot token scope. `chat:write` is not used.
4. Install or reinstall the app to the workspace and copy the app's client ID and client secret into the existing, uncommitted backend `.env`.
5. Set:

   ```env
   SLACK_CLIENT_ID=your-app-client-id
   SLACK_CLIENT_SECRET=your-app-client-secret
   SLACK_REDIRECT_URI=http://localhost:5000/api/integrations/slack/callback
   SLACK_WEBHOOK_ENCRYPTION_KEY=64-hexadecimal-characters
   ```

   Generate the encryption key with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Keep this key stable and back it up securely. Changing it without decrypting/re-encrypting stored webhook values makes existing connections unusable. `.env.example` intentionally contains no secrets.
6. Run `npm run db:migrate`, start the API and email worker, sign in with Google, and choose **Connect Slack** from the authenticated dashboard. Select the destination channel in Slack. The dashboard should show the workspace and channel. Use **Reconnect** to replace the current destination or **Disconnect** to remove the active webhook.

The browser must use the same host (`localhost`) as the Slack redirect URI so the session cookie used for OAuth state validation is preserved. If the backend origin differs from the local default, set `VITE_AUTH_API_ORIGIN` in `client/.env.local` and restart Vite.

## Trigger and verify a live notification

1. Connect the workspace/channel that should receive the alert.
2. In backend `.env`, temporarily set `MAX_EMAILS_PER_SENDER_PER_HOUR=2`. Use distinct email jobs for the same configured sender in one rate-limit window. Ensure the scheduling delay permits more than two messages to reach the worker.
3. Restart the backend email worker so it loads the temporary limit, then queue at least three emails. The first two acquire sender capacity; subsequent emails are put into BullMQ's delayed set until the fixed-window capacity resets.
4. Verify one alert appears in the selected Slack channel. The message includes the sender, configured limit, event time in UTC, and pending email count when available. Slack webhook requests execute on the separate `slack-notifications` BullMQ queue; network, timeout, and invalid-webhook failures are retried there and do not fail email jobs.
5. Restore the normal limit and restart the worker. Disconnecting Slack prevents subsequent queued notifications from delivering; reconnecting changes the webhook used by notifications that are processed afterward.

Automated tests mock the Slack OAuth exchange or webhook request. A live Slack message requires a real Slack app installation and is not claimed by the automated test suite.

## Queue and rate-limit behavior

- PostgreSQL remains the source of truth for scheduled email records. The scheduler reads pending rows in batches of 100 and bulk-enqueues stable `email-<email-id>` BullMQ job IDs, rather than loading an entire campaign into memory.
- BullMQ email-worker concurrency defaults to 2 and is clamped to 1–50. The Slack notification worker defaults to 2 and is clamped to 1–10.
- Redis Lua atomically reserves fixed-hour capacity and enforces the per-sender minimum delay. The former BullMQ global limiter and worker-side sleep loop are removed, so a saturated sender cannot occupy email worker slots or throttle unrelated sender accounts.
- Rate-limited jobs are moved to BullMQ's delayed set without consuming a retry attempt or being marked sent/failed. Redis/BullMQ delayed jobs survive application restarts; configure Redis persistence (AOF or an appropriate RDB policy) if jobs must also survive Redis process/data loss.
- A Redis `SET NX` key and deterministic BullMQ notification job ID deduplicate alerts for a sender and rate-limit window. The notification worker reads the current active PostgreSQL integration per job, so disconnect/reconnect changes take effect without restarting.
- Slack OAuth state is session-bound, single-use, timing-safe compared, and expires after ten minutes. Rate-limit configuration rejects invalid numeric values at runtime instead of silently turning off a limit.
- Authentication and authenticated Slack integration endpoints are additionally limited to 30 requests per client IP per minute using atomic Redis counters; `429` responses include `Retry-After`.
- Gmail API does not guarantee exactly-once delivery. A database send-attempt marker prevents an automatic second API submission after an ambiguous result; the email must be verified manually before rescheduling.
