---
name: chile-run
description: The Chilean book's pipeline, apart from the US one — read a new Itaú statement if one was dropped, sync the IPSA & SCL Dr Market group, digest its charts and PDFs, run the analysis with the same playbook as the US book, check it, and put the report on its own private page for the phone. Orders are placed by hand at Itaú; nothing is traded from here.
disable-model-invocation: true
---

# Chilean run: preflight → digest → analysis → checks → phone

A second portfolio at a second broker, analysed with the same rules as the US
book and kept apart from it: its own group, statement, ADD ledger, reports
(`.whatsapp/cl/`) and phone page. It never runs the US preflight, never syncs
the US groups, never calls the `mcp__stock-recommender__*` tools and never
touches the dashboard's recommendations. The WhatsApp client in the running
dashboard (`http://localhost:3000`) is the only thing the two runs share.

Keep the user posted with one line per step. Stop and report if a step
fails; never publish a report written on a failed sync.

**No API credits.** Every model call runs on the Claude plan through the two
agents of step 2.

**When it runs.** By hand, after the Santiago close (16:00). A schedule exists
but is NOT installed (the user's choice, 2026-10-19): 17:30 local time from
Monday to Friday, `scripts/cl/schedule/com.stock-recommender.chile-run.plist`,
installed with `scripts/cl/scheduled-run.sh --install` — hours away from the US run's 08:30 start, and both take the same lock so
two syncs never overlap. The report is written on that day's closes and its
orders are for the next open. Friday's run is the WEEKLY review. `TODAY` is
the Santiago date (`date +%F`).

**Unattended.** `/chile-run unattended` (what the schedule sends) does every
step, asks nothing, and ends with a PushNotification of one line: the number
of orders to type into the Itaú app and the first thing that needs attention,
or the step that failed. No step places an order: the book is at Itaú, which
has no connector. The Zesty connector is used read-only for Chilean market
data (price, order book, presencia bursátil; it has no filings, dividends or
results — those come from the CMF); its order tools are denied on
the scheduled run's command line.

## The book comes from a PDF

Itaú has no connector. The book is the latest "Informe Mensual de Cartera"
(`informeMensual*.pdf`) the user exports from Itaú and drops in the project
root or in `~/Downloads`. The preflight reads any newer one, checks that it
adds up to the statement's own total, stores it in
`.whatsapp/cl/holdings/<date>.json` and moves the PDF to
`.whatsapp/cl/statements/` (git-ignored: it carries the client's name, RUT and
address; never commit it, never paste those into a report). Between
statements the book is the last one at today's prices, so a trade the user
made since is missing: the report says which statement it stands on, and the
preflight warns when it is over a week old.

## 0–1. Preflight

`curl -sf localhost:3000/api/whatsapp/status`. If it doesn't answer, start
`pnpm dev` with `run_in_background: true` and wait (Monitor with an until-loop
on that curl). Then, in the foreground with a 10-minute timeout:

```
python3 scripts/cl/preflight.py            # add `weekly` to force the review, `backfill` for a 14-day backfill
```

It reads a new statement, syncs the IPSA group alone (one reconnect, a
backfill on a gap), syncs the Telegram sources (`CL_TELEGRAM_CHATS`: Dividendos Chile, Zesty
Chile, Zesty Comunidad, Independencia Financiera, Análisis Técnico CHILE -
USA) live as the user's account (`scripts/cl/telegram-sync.mts`; only those
chats, never DMs, never sends; Hablemos de Chile is history only, since the
user is no longer in it); with no valid session it says so and falls back to the newest
`~/Downloads/Telegram Desktop/ChatExport_*` of each, matched by chat name (the
user logs in again with `scripts/cl/telegram-login.mts`; not a stop),
syncs each held and ADD name's CMF filings from cmfchile.cl (`scripts/cl/cmf.mts sync`: the year's material facts with their
texts — scans read by macOS OCR —, the statements calendar, the latest
análisis razonado and the statements' XBRL (with last December's, for twelve
months; the bundle splits each profit into business and accounting lines and
gives P/E, P/B and ROE against the sector — banks and AFPs file no XBRL there),
cached in `.whatsapp/cl/cmf/`; the first run compiles the
OCR helper, about a minute; a failed CMF sync is not a stop),
prints the corpus status and writes `TODAY.run.json`. It
ends with the lines for the analyst's prompt: TODAY, DEPTH, PREV,
`fullDetailDays`, the session and the statement.

**Exit code 2 is a stop:** the dashboard is down (start it, run again);
WhatsApp is `qr` or `disconnected` (the user must scan the QR at
http://localhost:3000; unattended: notify); the reconnect failed with "The
browser is already running for …/.stock-recommender-wa/session" (kill only
processes whose command line has
`--user-data-dir=<home>/.stock-recommender-wa/session`, then run again); the
sync failed twice; no statement has ever been read (ask the user for the
PDF). A statement that could not be parsed is not a stop: the run goes on with
the stored one and says so.

## 2. Digest, then analyse

**If an agent dies on a usage limit, do not resume it.** Start a NEW agent
with the same prompt when the limit resets: saved digests persist.

### 2a. `cl-media-digester` (Sonnet, medium)

Only when the preflight's status line shows files awaiting a digest:

> Digest the Chilean group's pending media, at most 30 files, and report what
> is still pending.

Run it again while files remain. Keep its notes: stale editions, unreadable
files, chart skills loaded.

### 2b. `cl-analyst` (Opus, high)

> Run the Chilean analysis for TODAY at depth DEPTH (the playbook's REPORT
> DEPTH). The IPSA group was just synced and its media digested.
> When this is written: <the preflight's "Session" line>. The orders are for
> the next Santiago open.
> The book: <the preflight's "Book" line, with the change since the last
> statement, or "unchanged">.
> Media notes from the digester: <stale editions, unreadable files, or none>.
> The previous Chilean report is PREV <path in .whatsapp/cl/reports/, or "none:
> this is the first report">.
> Build the bundle with `--full-detail-days N`, follow your instructions, save
> the report, the JSON and the orders file for TODAY, and return what your
> instructions list.

## 3. Checks

```
python3 scripts/cl/check.py TODAY
```

The shape of every row, a row for every held ticker, entries within 2% of
the market, shares × price against the stated CLP, sales within the shares
held, buys within the money-market fund plus account cash plus the session's
sales, the risk budget on every BUY, and the orders file against the report.
On `FAIL`, fix a slip of shape or arithmetic in the JSON yourself and run it
again; anything else (a price that is off, a size over the risk budget) goes
back to the user. Unattended: do not publish, notify with the failed check.

## 4. Phone page

One private page with one fixed link, replaced on every run, separate from
the US page:
https://claude.ai/artifact/YbhruJmz8FpUqySmgy8NRS

1. `pnpm exec tsx scripts/cl/report-page.ts TODAY` writes
   `.whatsapp/cl/reports/TODAY.html`: the orders as cards to type into the
   Itaú app (sales, then the fund redemption, then the buys), the book, and
   the report folded by section.
2. Load the Artifact tool with ToolSearch, `read` the link above, then publish
   `.whatsapp/cl/reports/TODAY.html` with `url` set to it and no `icon`.
   Never publish without `url`: it would create a second page and leave the
   phone on the old report.
3. The page stays private.

Only publish a report that passed step 3.

## Report back

- The statement the book stands on, its age, and what changed since the last
  one.
- WhatsApp: new messages and media, whether the job reconnected or
  backfilled.
- CMF: names synced, new material facts since the last run, results due in
  the next 10 days, any name that failed to sync.
- Earnings quality: the held names whose profit the statements flag (growth
  not from the business, deferred tax, exchange or indexation lines), with
  their P/E against the sector median.
- Files digested, chart skills loaded, stale editions, anything undigested.
- The depth, and any ADD recorded in the Chilean ledger this run.
- The 🩺 Portfolio health section with the Stops table.
- The orders to place at Itaú, in order, and the agent's actions table.
- Which checks ran and passed, and the phone page link.
