# ReachInbox demo script (maximum five minutes)

This is a recording plan, not a claim that the demo has been performed. Use synthetic recipients and a test Google account. Ethereal captures messages for preview and does not deliver them to real inboxes.

## Before recording

1. Configure `.env` using `.env.example`: matching `POSTGRES_PASSWORD` and `DATABASE_URL`, Google OAuth values, `FRONTEND_URL`, and a strong `SESSION_SECRET`. Never show credentials, cookies, or real recipient data.
2. From the project root:

   ```powershell
   docker compose up -d
   npm run db:migrate
   ```

3. In separate project-root terminals:

   ```powershell
   npm run dev
   ```

   ```powershell
   npm run worker
   ```

   ```powershell
   npm --prefix client run dev
   ```

4. Open `http://localhost:5173` and sign in with Google. Connect a test Slack workspace before recording only if showing a live alert.

## 0:00–0:30 — Introduction

Show the dashboard. Explain that React/TypeScript talks to an Express API; campaigns and email state live in PostgreSQL; BullMQ jobs and sender-limit state use Redis; Ethereal is used for test sending; Elasticsearch powers sent-email search; Slack alerts are optional.

## 0:30–1:30 — Create scheduled emails

Open **Compose New Email**. Add synthetic recipient(s), subject and body. Optionally upload a small CSV/text recipient list and show its valid, invalid, and duplicate counts. Set the minimum delay and a future send time about two minutes ahead, then schedule.

**Expected:** the confirmation reports queued count and the Scheduled view displays the email records.

## 1:30–2:15 — Dashboard

Show Scheduled, Sent, and an email detail view. Explain that Sent means Ethereal accepted the test message, not that it arrived in a real inbox. The current UI does not show the Ethereal preview link.

## 2:15–3:30 — Restart persistence

Use the future-dated item. Show it as scheduled, then press **Ctrl+C** in the API and worker terminals. Do not remove Docker volumes. Restart:

```powershell
npm run dev
```

In the worker terminal:

```powershell
npm run worker
```

After the scheduled time, refresh the dashboard.

**Expected:** PostgreSQL retains the email row and Redis/AOF retains the delayed BullMQ job; the restarted worker can process it when eligible. Do not claim persistence was demonstrated unless observed in the recording.

## 3:30–4:30 — Rate limiting and concurrency

Use only a test campaign and synthetic recipients. Set these values in `.env`:

```env
MAX_EMAILS_PER_SENDER_PER_HOUR=2
SENDER_RATE_LIMIT_WINDOW_MS=3600000
MIN_EMAIL_DELAY_MS=2000
WORKER_CONCURRENCY=2
```

Stop and restart the worker with `npm run worker` so it loads the new settings. Queue at least three jobs using the **same sender identity** within the same fixed window and with a short scheduling stagger. Show delayed work in Bull Board at `http://localhost:5000/admin/queues` (HTTP Basic Auth is available only if configured).

**Expected:** two reservations can proceed; later same-sender jobs are delayed. Different sender accounts have separate counters; campaigns with no account share the Ethereal fallback sender key. Show a Slack message only if a real notification is received in the channel.

Restore the normal environment values and restart the worker after recording. Do not delete shared queue data or use production campaigns.

## 4:30–5:00 — Conclusion

Summarize PostgreSQL persistence, Redis/BullMQ delayed jobs, sender limits, bounded concurrency, and optional Slack alerts. Clearly state that Ethereal is a test transport and Gmail SMTP/real inbox delivery are not implemented. End on the dashboard or README.
