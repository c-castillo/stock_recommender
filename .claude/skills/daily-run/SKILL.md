---
name: daily-run
description: The full daily pipeline in one command — sync the Zesty portfolio, download the WhatsApp groups, mark noise and digest new charts/PDFs, run the stock analysis at high effort, publish the report and recommendations to the web dashboard, put the report on a private page for the phone, and offer to place the report's orders and stops at Zesty once the user approves each one.
disable-model-invocation: true
---

# Daily run: Zesty → WhatsApp → noise + digest → analysis → publish → phone → orders

Do every step yourself with tool calls — no helper scripts beyond the page
renderer of step 6 and the two scripts of step 3. Everything goes
through the running dashboard at `http://localhost:3000` (the WhatsApp client
and the Zesty login both live inside the Next.js process). Stop and report if a
step fails; never publish recommendations from an analysis that ran on a failed
sync or a stale corpus. Keep the user posted with one line per step.

**No API credits.** Every model call in this flow runs on the Claude plan,
through the two agents in step 4. Don't call `/api/analyze` or
`scripts/sweep-relevance.ts` from here — those bill the Anthropic API key.

**When it runs.** Once a day, in the evening after the US close (16:00 New
York), so prices are the day's closes and the orders are ready for the next
open. `TODAY` below is the local date (`date +%F`), not the UTC one. A second
run on the same day replaces that day's report, snapshot and wiki entries.
During market hours use `/stop-check` instead: it syncs Zesty and prints each
holding against its stop, with no agents and nothing published. A full run
before the close cannot decide a stop that waits for a close.

**Depth.** `DEPTH` is `WEEKLY` or `DAILY`, and goes in the analyst's prompt:

- `WEEKLY` (the full review of every ticker in the window) when TODAY is a
  Friday, Saturday or Sunday and no report dated since that Friday has
  `Depth: WEEKLY` on its second line; when the newest report is more than
  seven days old; or when the user asks for it (`/daily-run weekly`).
- `DAILY` otherwise: orders, stops and what changed.

## 0. Dashboard up?

`curl -sf localhost:3000/api/whatsapp/status`. If it doesn't answer, start
`pnpm dev` with `run_in_background: true` and wait (Monitor with an until-loop
on that curl) until it does.

Then `python3 scripts/mcp-smoke.py`: it starts the MCP server from the code on
disk and calls the tools the run depends on. If it fails, stop: the analysis
cannot be built. If it passes but this session has no `mcp__stock-recommender__*`
tools (the session's own connection is down or older than the code), tell both
agents to use the shell bridge, `python3 scripts/mcp-call.py`, described in
their instructions, and say so in the report.

## 1. Zesty portfolio

1. Baseline = the book as of the last published report: the newest
   `.whatsapp/reports/*.portfolio.json`. Only if there is none, use
   `curl -s localhost:3000/api/portfolio` taken before the sync. Do NOT diff
   against the stored portfolio when a snapshot exists — a second sync in one
   day would hide the day's trades.
2. `curl -s -m 180 -X POST localhost:3000/api/portfolio/sync-zesty`

It logs into Zesty headlessly, replaces the stored positions and cash, and
records the day's total in the portfolio history. Diff the response against the
baseline: new or closed positions, share-count changes, **average-cost
changes**, and the cash delta. The response has two cash numbers:
`cash_balance` is all the cash and counts in the book's value; `buying_power`
is what a new order can spend, lower while a buy order is open. Zesty's average cost is the cost of the
shares still held, so it moves on a partial sell (the sold lots leave the
average). That is expected and reliable — report it, don't flag it. A 502 means
the login failed (credentials in `.env.local`, or Zesty changed its login flow)
— say so and continue with the stored portfolio, flagging that the analysis
uses the last successful sync.

3. Explain the diff with the claude.ai Zesty connector, read-only tools only
   (load them with ToolSearch; if the connector is missing, skip this and say
   so). No `preview_*`, `confirm_*` or `cancel_order` call belongs in steps 1
   to 6: orders are only ever prepared in step 7, and only placed after the
   user approves them there.
   - Always → `get_orders` with `status: "pending"`: the open orders. Keep two
     lists for the analyst: the resting stops (ticker, shares, stop or trailing
     stop, level or trail %) and the open buys or sells. They are what the
     report's "Stops" table is checked against.
   - Shares changed → `get_orders`: the fill price and date of each trade. A
     filled stop order is an exit already taken: say so, with the ticker.
     When it closed a position that is an ACTIVE or AGING ADD, write it on the
     ledger row so later runs know: `record_main_analyst_add` with the ticker, the
     row's own `addedOn` (so the date does not move) and its note plus
     "STOPPED OUT <date> at <price>; not re-bought until the main analyst refreshes the
     ADD or price closes back above <stop>". Do not deactivate the row: only a
     a SELL from the main analyst or an exited EXPIRED/INVALIDATED row is deactivated.
   - Cash changed with no trade → `get_dividends`, then `get_movements`.
   - Always → `get_movements` with `type: "deposits"` and again with
     `"withdrawals"`: compare the newest movement date with
     `performance_anchor.lastFlowDate` in the sync response. A newer movement
     means the performance numbers are overstated or understated until
     `scripts/set-performance-anchor.ts` is refreshed — say so, and tell the
     analyst in step 4.

Report the diff in one or two lines and pass it to the analyst in step 4.

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
5. The job recovers by itself from `Attempted to use detached Frame` (WhatsApp
   Web reloaded inside the headless browser while status still says connected):
   it restarts the client once and retries, and sets `job.reconnected: true`.
   Only if groups still end in `error`, do it by hand:
   - `POST /api/whatsapp/disconnect`, then `POST /api/whatsapp/connect`, and
     wait for `status: connected`.
   - If connect fails with "The browser is already running for
     …/.stock-recommender-wa/session", an orphaned headless Chrome still holds
     the session lock. It is the app's own automation browser, not the user's
     Chrome: kill only processes whose command line has
     `--user-data-dir=<home>/.stock-recommender-wa/session`, then connect
     again. The session is on disk, so no QR is needed.
   - Retry the sync once. If it fails again, stop and show the error.
6. **Check for holes.** A group with `gap: true` stopped paging before it
   reached the point the previous sync had covered, so messages may be missing
   in between: run the job again with `"backfill": true` (14 days) and report
   it. Do the same when step 0 had to start the dashboard and a group still
   shows `newMessages: 0` on a trading day.
7. Report `newMessages` and `newMedia` per group — what this sync added.
   `messagesReceived` and `mediaDownloaded` are the group's running totals, not
   the day's intake. The live listener stores messages as they arrive, so a
   small number here does not mean a quiet day.

## 3. Scorecard and events

Two scripts, no model call. Run them after the sync and hand the analyst the
two files:

1. `python3 scripts/scorecard.py > .whatsapp/reports/TODAY.scorecard.md` prices
   every call of the last 45 days of reports: which orders were taken, what
   each stance did against SPY and SMH, and whether confidence ranked the
   outcomes.
2. `python3 scripts/events.py T1 T2 … > .whatsapp/reports/TODAY.events.md` with
   the held longs, the active ADDs not held (`main_analyst_adds`, or the "Sectors of
   active ADDs not held" line of the last bundle) and any ticker with an open
   order: the earnings dates of the next 21 days and the headlines of the last
   three.

If a script fails or a source is rate-limited, go on and tell the analyst which
block is missing; neither blocks the run.

## 4. Prepare the corpus, then analyse

Two agents, in order. The digester marks off-topic chatter and reads the
images, so the analyst's context holds neither.

**If an agent dies on a usage limit, do not resume it.** A resumed agent
re-sends its whole context uncached and usually dies again on the next turn.
When the limit resets, start a NEW agent with the same prompt: saved digests
persist, so little is lost.

### 4a. `media-digester` (Sonnet at medium effort)

> Prepare the corpus for TODAY's analysis: run the noise pass, then digest the
> pending media, at most 30 files, and report what is still pending.

Run it again while its report says messages or files are still pending. Keep
its report: messages classified and marked as noise, files digested, chart
skills loaded, stale editions, unreadable files. The noise pass only marks
(nothing is deleted, and 👽 USA Trading is exempt); if it could not run,
unclassified messages are treated as relevant, so the cost is a noisier bundle,
not a wrong one.

### 4b. `stock-analyst` (Opus at high effort)

Put TODAY in the paths and prompt. `PREV` is the newest earlier
`.whatsapp/reports/*.md`; `N` is the days between that report and TODAY,
minimum 2.

> Run the analysis for TODAY at depth DEPTH (the playbook's REPORT DEPTH). The
> Zesty portfolio and WhatsApp corpus were just synced, the noise pass ran, and
> the media was digested.
> Zesty change since the last report: <positions, average costs and cash
> before → after, with the fills and credits from step 1; any performance-anchor
> warning>. Open orders at Zesty: <resting stops: ticker, shares, type, level
> or trail %; open buys and sells; or "none">. Buying power: <buying_power>.
> Media notes from the digester: <stale editions, unreadable files>.
> The previous report is PREV. The scorecard is
> `.whatsapp/reports/TODAY.scorecard.md` and the earnings and headlines are
> `.whatsapp/reports/TODAY.events.md`: read both before you write <or: which
> one is missing>.
> 1. Call `corpus_status`; if the newest message is over a day old, stop and say
>    so. If it shows undigested media, digest it per your step 0.
> 2. Call `analysis_bundle` with `fullDetailDays: N`.
> 3. Write the report per the playbook and your instructions, at depth DEPTH.
>    Line 2 of the file is `Depth: DEPTH`.
> 4. Open the report with a **🩺 Portfolio health** section, before the market
>    summary, computed from the bundle's Portfolio, Performance, RRG and ADD
>    ledger blocks at live prices:
>    - Performance: 3M / 6M / YTD vs SPY, QQQ and the main sector ETF, the
>      drawdown from peak, and which way the windows disagree.
>    - Composition: % by sub-sector and theme (longs only), with the 35% / 60%
>      flags; cash %, and how much of it open orders have reserved.
>    - Hedges, from the bundle's "Hedges held" table: capital tied up, short
>      exposure, coverage (short exposure ÷ covered exposure), P&L since entry
>      and trading days held; which goes first when the theme is over its cap,
>      the trim or the hedge.
>    - Stops: one row per held long with the report's stop, what rests at Zesty
>      (from the open orders above) and the exact order to place when nothing
>      rests or it no longer matches.
>    - ADDs not held: one line each, a sized BUY or its single blocker, with the
>      swap when the blocker is a cap.
>    - The benchmark row (SMH) while the book trails it on 6M and YTD.
>    - Scorecard: two lines on what it shows, and what you changed because of it.
>    - Winners vs losers: the share of the book in positions losing money vs
>      making it, and whether the largest weights are the best or worst trends
>      (Chartizard rule 2).
>    - Rule breaches: holdings below a falling MA200 (rule 7), ledger ADDs that
>      are EXPIRED, INVALIDATED or flagged ⚠, and sectors above their cap
>      without a trim.
>    - Change since the last report (the 🩺 and 💡 sections of PREV, and the
>      Zesty diff above): what was traded, and whether the last session's
>      recommendations were followed.
>    - The top three fixes, each with shares and $ at live prices.
>    Keep it to the health table, the stops table and at most ten lines of
>    prose.
> 5. **Order size.** An order worth less than 1% of the book's total value is
>    not a fix: report the breach it would cure as "within tolerance" with the
>    $ amount, and don't list the order. Exceptions: an order that closes a
>    position, or one triggered by a stop, an invalidation level or a main-analyst
>    SELL. Placing or moving a resting stop is not an order row at all: it goes
>    in the Stops table.
> 6. Save the report to `.whatsapp/reports/TODAY.md`, before any optional check.
> 7. Save the recommendations to `.whatsapp/reports/TODAY.json` as
>    `{"recommendations": [...]}`, one object per ticker in the report's 💡 section
>    plus one per hedge instrument (on a DAILY run that is the short list the
>    playbook allows, and every held ticker is always in it), each with exactly: `ticker`, `company`,
>    `action` (BUY|SELL|HOLD), `confidence` (0-100 number), `entryPrice`,
>    `priceTarget`, `stopLoss` (strings or null, live-priced), `reasoning` (the
>    rationale with its dated evidence), `mentions` (corpus mentions this
>    session), `sources` (short dated source labels). Rows that are orders come
>    first and their `reasoning` starts with the order itself ("BUY 67 sh ≈
>    $701 — …"); a row for a ticker that is not held starts with "Not held — ".
>    `entryPrice` starts with the live price as a plain `$` number.
> 8. Save the orders this report asks for to `.whatsapp/reports/TODAY.orders.json`
>    as `{"orders": [...]}`: every order row of the 💡 section and every
>    "To place" cell of the Stops table, in the order they should be sent, each
>    with `ticker`, `side` (buy|sell), `type` (limit|stop|trailing_stop), `qty`
>    (whole shares), `limitPrice` or `stopPrice` or `trailPercent` (numbers),
>    `timeInForce` (day|gtc), `source` ("order" or "stop"), `stopTriggered`
>    (true when a fired stop or an invalidation is the reason for the sale),
>    `condition` (anything the broker cannot enforce, such as "do not buy if it
>    opens under $113.40", or null), `waitsFor` (the order that must fill first,
>    such as "BUY 10 EBAY", or null) and `why` (one line). An empty list when
>    the report asks for nothing.
> 9. Return: the depth, the chart skills you loaded (or "none"), both paths,
>    the 🩺 Portfolio health section verbatim (with its Stops table), and a
>    table of ticker / action / confidence / entry / stop plus the hedge line.

## 5. Publish to the web

1. Read the JSON and check its shape: a non-empty `recommendations` array;
   every row has a ticker, an action in BUY|SELL|HOLD, a numeric confidence and
   a reasoning string. Fix obvious shape problems yourself.
2. Check the numbers against the market and the book. For every BUY row and
   every SELL row of a held ticker:
   - `curl -s 'localhost:3000/api/prices?tickers=A,B,…'` and compare with the
     first `$` number in `entryPrice`: more than 2% apart is a stale or wrong
     price.
   - The order's shares × price matches its stated `$` amount within 2%.
   - A SELL is for no more shares than are held; the BUYs together cost no
     more than `buying_power` (the cash balance when it is null).
   - Every held ticker has a row.
   If any check fails, or the content otherwise looks wrong, stop and ask
   instead of publishing.
3. Back up the live set: `GET /api/recommendations` saved to
   `.whatsapp/recs-backups/<YYYYMMDD-HHMMSS>.json`.
4. `POST /api/recommendations` with
   `{"recommendations": [...], "narrative": <the full TODAY.md text>, "date": "TODAY"}`
   (build the body with `jq` or `python3` from the two files). It REPLACES the
   whole table, not merges. With `narrative` it also stores the report for the
   dashboard and appends each verdict to the per-ticker wiki.
5. `GET /api/recommendations` again and confirm the count, `generatedAt` and
   `narrativeAt` changed, and that the POST reported `wikiUpdated` equal to the
   row count.
6. Save the book this report was written against, for tomorrow's diff:
   `curl -s localhost:3000/api/portfolio > .whatsapp/reports/TODAY.portfolio.json`

The digests from step 4 are already in the database, so the web sees them
without this step.

## 6. Phone page

The computer stays home, so the report also goes to a private Claude artifact
the user opens from the Claude app on the phone. It is one page with one fixed
link, replaced every night:
https://claude.ai/artifact/QemrZbre8TisFcb3VT9zXx

1. `pnpm exec tsx scripts/report-page.ts TODAY` writes
   `.whatsapp/reports/TODAY.html` from the two files of step 4: the orders
   first, the standing conditionals, the book, then the full report. It is a
   plain renderer — no model call, no API credits. Its banner says what the
   prices are (closes, pre-market, intraday or a weekend) from the report date
   and the New York clock, so render right after the analysis.
2. Load the Artifact tool with ToolSearch, `read` the link above (a publish to
   an artifact this conversation has not read is refused), then publish
   `.whatsapp/reports/TODAY.html` with `url` set to that link and no `icon`.
   Never publish without `url`: that would create a second page and leave the
   phone on yesterday's report.
3. The page stays private. Don't share it or change who can open it.

Only publish a report that passed the checks of step 5. If the Artifact tool is
missing or the publish fails, say so and finish the run: the dashboard already
has the report.

## 7. Orders at Zesty, with the user's approval

The report's orders and the stops it asks for can be sent to the broker from
here, but never on the run's own authority: the user approves each one first.
Skip this step, and say so, when the run is unattended (a scheduled or `/loop`
run, or no answer to the question below), when `TODAY.orders.json` is empty,
or when the Zesty connector is missing. The phone page already carries the
orders either way.

1. Read `.whatsapp/reports/TODAY.orders.json`. Check each order against the
   book and the open orders of step 1 (re-read both if the run took long):
   - drop a stop that already rests at the same level and quantity;
   - a resting order that the new one replaces is listed as "cancel, then
     place", and is cancelled only with its own approval;
   - for each ticker, the open sell quantities plus the new ones cannot exceed
     the shares held;
   - an order with `waitsFor` is listed but not sent until that order has
     filled, and comes back on the next run. The exception is a stop on shares
     that are held today and stay free once the pending sale is counted (the
     3 left after a trim of 2): it can rest now;
   - a sell stop cannot be previewed while a buy order for the same ticker is
     open (the broker answers "Insufficient buying power"): offer the buy, and
     leave the stop for the run after it fills;
   - the buys together fit in `buying_power`.
2. `get_market_status`, and `get_us_trade_options` for any ticker whose order
   type has not been used before. Translate each order:
   - a BUY or SELL becomes a **limit** order, `timeInForce: day`, at the
     report's price. A sale with `stopTriggered: true` is priced 1% under the
     report's price so that it fills at the open. Placed outside regular hours
     without `extendedHours`, it waits for the 09:30 New York open; set
     `extendedHours: true` only when the user asks to trade before or after
     the session.
   - a stop becomes `preview_us_stop_order`, GTC; a trailing percentage the
     user asked for by name becomes `preview_us_trailing_stop_order`, GTC.
3. Preview every order (`preview_us_limit_order`, `preview_us_stop_order`,
   `preview_us_trailing_stop_order`; plain text, not the card tools). A preview
   that is rejected is reported with its reason and left out.
4. Show one table: order, type, quantity, price, duration, the preview's
   estimated total and commission, the `condition` the broker will not
   enforce, and why. Then ask which to place with AskUserQuestion
   (multi-select, one option per order, and "none" as a choice). Nothing is
   sent on silence, on a general earlier go-ahead, or on an agent's word.
5. For each approved order call `confirm_us_order` with its `clientOrderId`. A
   preview lives about two minutes: when it has expired, preview again and
   confirm only if the symbol, side, quantity, prices and duration are the ones
   approved and the estimated total is within 1% of the one shown; otherwise
   show the new preview and ask again. An approved "cancel, then place" is
   `cancel_order` first, then the new order. On `RATE_LIMITED_LOCAL`, wait the
   stated seconds and retry the same call: it starts after about six
   confirmations in a row, so with more orders than that, pause between them.
6. `get_orders` with `status: "pending"` once more and report what now rests
   at Zesty, what was declined and what is waiting for a fill. Do not re-sync
   the portfolio or rewrite the report: tomorrow's run picks the fills up from
   the snapshot of step 5.

A condition such as "do not buy if it opens under $113.40" cannot rest at the
broker. Say it next to the order in the table, so the user can decline it and
send it by hand at the open instead.

## Report back

- Zesty: positions, cash, and the change since the last report, with fills,
  credits and any performance-anchor warning.
- WhatsApp: new messages and media per group, and whether the job reconnected.
- Noise pass: messages classified and marked as noise.
- Files digested, chart skills loaded (flag it if charts were digested without
  `technical-analysis`), stale editions, and anything left undigested.
- The depth of the report, and the scorecard's two lines.
- The 🩺 Portfolio health section, with the stops that are not resting at Zesty
  and the order to place for each.
- The agent's actions table and hedge line.
- The report path, the portfolio snapshot path and the backup path.
- Which publish checks ran and passed.
- The phone page link, and whether tonight's report is on it.
- The orders offered in step 7: which were approved and now rest at Zesty,
  which were declined, rejected or left waiting for a fill.
