---
name: daily-run
description: The full daily pipeline in one command — sync the Zesty portfolio, download the WhatsApp groups, digest new charts/PDFs, run the stock analysis at max effort, and publish the recommendations to the web dashboard.
disable-model-invocation: true
---

# Daily run: Zesty → WhatsApp → digest + analysis → publish

Do every step yourself with tool calls — no helper scripts. Everything goes
through the running dashboard at `http://localhost:3000` (the WhatsApp client
and the Zesty login both live inside the Next.js process). Stop and report if a
step fails; never publish recommendations from an analysis that ran on a failed
sync or a stale corpus. Keep the user posted with one line per step.

## 0. Dashboard up?

`curl -sf localhost:3000/api/whatsapp/status`. If it doesn't answer, start
`pnpm dev` with `run_in_background: true` and wait (Monitor with an until-loop
on that curl) until it does.

## 1. Zesty portfolio

`curl -s -m 180 -X POST localhost:3000/api/portfolio/sync-zesty`

It logs into Zesty headlessly and replaces the stored positions and cash. Read
the response: report the position count and cash, and compare them with the
previous state if you know it (new or closed positions, a cash change = a
trade happened). A 502 means the login failed (credentials in `.env.local`, or
Zesty changed its login flow) — say so and continue with the stored portfolio,
flagging that the analysis uses the last successful sync.

## 2. WhatsApp messages

1. From `/api/whatsapp/status`, check `status` is `connected`, and take the
   groups with `selected: true` (the analysis groups — selection lives in code).
   If it's `qr` or `disconnected`, stop: the user has to scan the QR at
   http://localhost:3000.
2. `POST /api/whatsapp/sync-job` with
   `{"groups":[{"jid","name"}…],"backfill":false}`. A 400 "Ya hay una
   sincronización en curso" means a job is already running — just wait on it.
3. Poll `GET /api/whatsapp/sync-job` until `job.status` isn't `running`
   (Monitor with an until-loop, not repeated manual calls).
4. **Judge the groups, not the job.** The job says `done` even when every group
   failed, so read each group's `status` and `error`.
5. If groups failed with `Attempted to use detached Frame` (WhatsApp Web
   reloaded inside the headless browser while status still says connected):
   - `POST /api/whatsapp/disconnect`, then `POST /api/whatsapp/connect`, and
     wait for `status: connected`.
   - If connect fails with "The browser is already running for
     …/.stock-recommender-wa/session", an orphaned headless Chrome from the
     dead client still holds the session lock. It is the app's own automation
     browser, not the user's Chrome: kill only processes whose command line
     has `--user-data-dir=<home>/.stock-recommender-wa/session`, then connect
     again. The session is on disk, so no QR is needed.
   - Retry the sync once. If it fails again, stop and show the error.
6. Report messages and media received per group.

## 3. Digest + analysis at max effort

Delegate to the `stock-analyst` agent (Opus at max effort; it also keeps the
chart images out of this context). Put today's date in the paths and prompt:

> Run the full daily analysis for YYYY-MM-DD. The Zesty portfolio and WhatsApp
> corpus were just synced.
> 1. Call `corpus_status`; if the newest message is over a day old, stop and say so.
> 2. Digest every file from `pending_media` (repeat until none remain), following
>    your step 0 and the chart-reading skills. Flag stale newspaper editions.
> 3. Write the full report per the playbook and your instructions.
> 4. Save the report to `.whatsapp/reports/YYYY-MM-DD.md`.
> 5. Save the recommendations to `.whatsapp/reports/YYYY-MM-DD.json` as
>    `{"recommendations": [...]}`, one object per ticker in the report's 💡 section
>    plus one per hedge instrument, each with exactly: `ticker`, `company`,
>    `action` (BUY|SELL|HOLD), `confidence` (0-100 number), `entryPrice`,
>    `priceTarget`, `stopLoss` (strings or null, live-priced), `reasoning` (the
>    rationale with its dated evidence), `mentions` (corpus mentions this
>    session), `sources` (short dated source labels).
> 6. Return: files digested, anything left undigested, both paths, and a table of
>    ticker / action / confidence / entry / stop plus the hedge line.

## 4. Publish to the web

1. Read the JSON and check it: a non-empty `recommendations` array; every row
   has a ticker, an action in BUY|SELL|HOLD, a numeric confidence and a
   reasoning string. Fix obvious shape problems yourself; if the content looks
   wrong, stop and ask instead of publishing.
2. Back up the live set: `GET /api/recommendations` saved to
   `.whatsapp/recs-backups/<YYYYMMDD-HHMMSS>.json`.
3. `POST /api/recommendations` with the file as the body. It REPLACES the whole
   table, not merges.
4. `GET /api/recommendations` again and confirm the count and `generatedAt`
   changed.

The digests from step 3 are already in the database, so the web sees them
without this step.

## Report back

- Zesty: positions, cash, and any change since the last sync.
- WhatsApp: messages and media per group, and whether a reconnect was needed.
- Files digested and anything left undigested.
- The agent's actions table and hedge line.
- The report path and the backup path.
- What the web still won't show: the narrative and per-ticker history, which
  only the dashboard's own Analyze button writes.
