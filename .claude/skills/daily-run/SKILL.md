---
name: daily-run
description: The full daily pipeline in one command — sync the Zesty portfolio, download the WhatsApp groups, mark noise and digest new charts/PDFs, run the stock analysis at high effort, publish the report and recommendations to the web dashboard, put the report on a private page for the phone, and offer to place the report's orders and stops at Zesty once the user approves each one.
disable-model-invocation: true
---

# Daily run: preflight → noise + digest → analysis → publish → phone → orders

The mechanical steps are two scripts, so they are the same every day:
`scripts/preflight.py` (the syncs, the diff, the last report's orders, the
scorecard, the events) and `scripts/publish-check.py` (the checks and the
publish). You run them, read what they print, and do what needs judgement: the
two agents of step 4, the phone page, and the orders with the user's approval.
Everything goes through the running dashboard at `http://localhost:3000` (the
WhatsApp client and the Zesty login both live inside the Next.js process). Stop
and report if a step fails; never publish recommendations from an analysis
that ran on a failed sync or a stale corpus. Keep the user posted with one
line per step.

**No API credits.** Every model call in this flow runs on the Claude plan,
through the two agents in step 4. Don't call `/api/analyze` or
`scripts/sweep-relevance.ts` from here — those bill the Anthropic API key.

**When it runs.** Once a day **before the US open** (09:30 New York), scheduled
at 08:30 local time from Monday to Saturday by
`scripts/schedule/com.stock-recommender.daily-run.plist`. The report is written
on the closes of the session that ended the evening before, with the night's
news and the pre-market prints beside them, and its orders are for the open
that follows. Saturday's run is the weekly review on Friday's closes. `TODAY`
is the local date (`date +%F`); the session the prices belong to is in
`TODAY.run.json`, which the preflight writes. A second run on the same day
replaces that day's report, snapshot and wiki entries. During market hours use
`/stop-check` instead: a full run while the market is open cannot decide a
stop that waits for a close.

**Unattended.** `/daily-run unattended` (what the schedule sends) does steps 0
to 6 and stops: it asks nothing, places nothing and skips step 7. The Zesty
trading tools are denied to that session by its own command line
(`scripts/scheduled-run.sh`), so this is a fact and not a promise. It ends
with a PushNotification of one line: the number of orders waiting for
approval and the first thing that needs attention, or the step that failed.
The user then approves the orders from the phone page (step 6) or by running
`/daily-run orders` here, which does step 7 alone on today's report.

**Depth.** `DEPTH` is `WEEKLY` or `DAILY`; the preflight decides it and prints
it, and it goes in the analyst's prompt:

- `WEEKLY` (the full review of every ticker in the window, with the rule
  review) on the first run after a week has closed (Saturday, or Sunday or
  Monday when Saturday's did not happen); when the newest report is more than
  seven days old; or when the user asks for it (`/daily-run weekly`, which is
  `preflight.py weekly`).
- `DAILY` otherwise: orders, stops and what changed.

## 0 to 3. Preflight

`curl -sf localhost:3000/api/whatsapp/status`. If it doesn't answer, start
`pnpm dev` with `run_in_background: true` and wait (Monitor with an until-loop
on that curl) until it does. Then:

```
python3 scripts/preflight.py            # add `weekly` to force the weekly review
```

It takes a few minutes (the Zesty login and the WhatsApp sync), so run it in
the foreground with a 10-minute timeout. In order it does:

0. The MCP smoke test: the server is started from the code on disk and the
   tools the run depends on are called.
1. The Zesty sync, and the diff against the book of the last report (the newest
   `*.portfolio.json`, never the stored book: a second sync in a day would hide
   the day's trades). The sync also reads the broker's orders: what rests there
   and what filled, expired or was cancelled.
2. The WhatsApp sync of the selected groups, judged group by group. A group in
   error gets one disconnect and connect and one retry; a group with
   `gap: true` gets a 14-day backfill.
3. What became of the last report's orders (`TODAY.orders-status.md`), the
   scorecard (`TODAY.scorecard.md`, with the rule review on a WEEKLY run) and
   the earnings and headlines (`TODAY.events.md`) for the held longs, the ADDs
   not held, every ticker with an open order and every name the last report
   wanted to buy.

It writes `TODAY.run.json` and ends with the lines for the analyst's prompt:
TODAY, DEPTH, PREV, `fullDetailDays`, the session and what the prices are.

**Exit code 2 is a stop.** Read the `STOP:` line and act on it:

- The dashboard does not answer: start it and run the preflight again.
- The MCP smoke test failed: the analysis cannot be built. Stop.
- WhatsApp is `qr` or `disconnected`: the user has to scan the QR at
  http://localhost:3000. Stop (unattended: notify).
- The reconnect failed with "The browser is already running for
  …/.stock-recommender-wa/session": an orphaned headless Chrome holds the
  session lock. It is the app's own automation browser, not the user's Chrome:
  kill only processes whose command line has
  `--user-data-dir=<home>/.stock-recommender-wa/session`, then run the
  preflight again. The session is on disk, so no QR is needed.
- The sync failed twice: stop and show the error.

**Not a stop:** a Zesty login that failed (the preflight says so and goes on
with the stored book: tell the analyst the book is the last successful sync),
or a script of step 3 that failed (tell the analyst which block is missing).
If the smoke test passes but this session has no `mcp__stock-recommender__*`
tools, tell both agents to use the shell bridge, `python3 scripts/mcp-call.py`,
and say so in the report.

Then, what the script cannot judge:

- **Average cost.** Zesty's average cost is the cost of the shares still held,
  so it moves on a partial sell. That is expected and reliable: report it,
  don't flag it. `cash_balance` is all the cash and counts in the book's value;
  `buying_power` is what a new order can spend, lower while a buy is open.
- **A stop that filled.** When the orders status shows a filled stop that
  closed a position which is an ACTIVE or AGING ADD, write it on the ledger row:
  `record_main_analyst_add` with the ticker, the row's own `addedOn` (so the
  date does not move) and its note plus "STOPPED OUT <date> at <price>; not
  re-bought until the main analyst refreshes the ADD or price closes back above
  <stop>". Do not deactivate the row: only a SELL from the main analyst or an
  exited EXPIRED/INVALIDATED row is deactivated.
- **Cash that moved with no trade**, with the claude.ai Zesty connector,
  read-only tools only (load them with ToolSearch; if the connector is missing,
  skip this and say so): `get_dividends`, then `get_movements`. And always
  `get_movements` with `type: "deposits"` and again with `"withdrawals"`: a
  movement newer than the preflight's "last deposit or withdrawal on record"
  means the performance numbers are off until
  `scripts/set-performance-anchor.ts` is refreshed. Say so, and tell the
  analyst.
- No `preview_*`, `confirm_*` or `cancel_order` call belongs in steps 0 to 6:
  orders are only ever prepared in step 7, and only placed after the user
  approves them there.
- `newMessages` and `newMedia` are what this sync added. The live listener
  stores messages as they arrive, so a small number does not mean a quiet day.

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

Fill the prompt from the preflight's last lines and from `TODAY.run.json`:
TODAY, DEPTH, PREV and `N` (`fullDetailDays`).

> Run the analysis for TODAY at depth DEPTH (the playbook's REPORT DEPTH). The
> Zesty portfolio and WhatsApp corpus were just synced, the noise pass ran, and
> the media was digested.
> When this is written: <the preflight's "Session" line: the session whose
> closes the prices are, and whether the market has opened>. The orders are
> for the next open. Title the report with the session and "before the open".
> Zesty change since the last report: <the preflight's diff; any
> performance-anchor warning; or "the Zesty login failed: the book is the last
> successful sync">. Open orders at Zesty: <the preflight's resting stops and
> open buys and sells; or "none">. Buying power: <buying_power>.
> Media notes from the digester: <stale editions, unreadable files>.
> The previous report is PREV. Read these three before you write <or: which
> one is missing>: `.whatsapp/reports/TODAY.orders-status.md` (what became of
> PREV's orders, from the broker), `.whatsapp/reports/TODAY.scorecard.md` and
> `.whatsapp/reports/TODAY.events.md`.
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
>      (from the bundle's "Orders at the broker" block) and the exact order to
>      place when nothing rests or it no longer matches. A trailing level comes
>      from the bundle's "Highest close since entry" table.
>    - ADDs not held: one line each, a sized BUY or its single blocker, with the
>      swap when the blocker is a cap.
>    - The benchmark row (SMH) while the book trails it on 6M and YTD.
>    - Costs, from the bundle's "Costs" section: the commission of each order
>      in $ and of the session's orders together, what the cash earns per week,
>      what the hedges' capital gives up per week, and each window's return
>      against the Performance table's Cash column.
>    - Last report's orders, from the orders status: one line per order that
>      did not fill, saying re-issued, replaced or dropped and why; fills at
>      their fill price.
>    - Risk: for every BUY, the $ lost at its stop and that as a % of the book,
>      against the 0.75% budget; held names over twice the budget.
>    - Scorecard: two lines on what it shows, and what you changed because of
>      it. On a WEEKLY run, the rule review in three lines and at most one
>      "Proposed rule change:".
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
>    `mustFill` (true for a sale a rule requires; its `limitPrice` is then 0.5%
>    under the last regular-session price, per the playbook's HOW ORDERS ARE
>    PRICED), `attachStop` (for a BUY that opens a new position: the stop
>    level, a number, sent with the buy, and that position then has no
>    separate stop entry; null otherwise),
>    `condition` (anything the broker cannot enforce, such as "do not buy if it
>    opens under $113.40", or null), `waitsFor` (the order that must fill first,
>    such as "BUY 10 EBAY", or null) and `why` (one line). An empty list when
>    the report asks for nothing.
> 9. Return: the depth, the chart skills you loaded (or "none"), both paths,
>    the 🩺 Portfolio health section verbatim (with its Stops table), and a
>    table of ticker / action / confidence / entry / stop plus the hedge line.

## 5. Publish to the web

```
python3 scripts/publish-check.py TODAY            # the checks alone
python3 scripts/publish-check.py TODAY --publish  # checks, backup, publish, verify, snapshot
```

The checks, the same every day: the shape of every row; each BUY's and held
SELL's entry price within 2% of the market; shares × price against the stated
$; no sale for more shares than are held and buys that fit in buying power;
every held ticker has a row; no new position opened within three sessions of
its own results; no BUY that loses more than the risk budget at its stop; the
orders file agrees with the order rows, and a must-fill sale is priced under
the market.

Run it without `--publish` first. On `FAIL`, fix what is a slip of shape or
arithmetic in the JSON yourself and run it again; anything else (a price that
is off, a buy into results, a size over the risk budget) goes back to the user:
stop and ask instead of publishing. Unattended, do not publish: notify with the
failed check and end the run.

With `--publish` it backs up the live set to `.whatsapp/recs-backups/`, POSTs
`{"recommendations", "narrative", "date"}` to `/api/recommendations` (which
REPLACES the whole table, stores the report for the dashboard and appends each
verdict to the per-ticker wiki), confirms the dashboard took it, and saves the
book this report was written against to `TODAY.portfolio.json` for tomorrow's
diff.

The digests from step 4 are already in the database, so the web sees them
without this step.

## 6. Phone page

The computer stays home, so the report also goes to a private Claude artifact
the user opens from the Claude app on the phone. It is one page with one fixed
link, replaced on every run:
https://claude.ai/artifact/QemrZbre8TisFcb3VT9zXx

1. `pnpm exec tsx scripts/report-page.ts TODAY` writes
   `.whatsapp/reports/TODAY.html` from the files of step 4: the orders
   first, then the same orders as one block of text to paste into the Claude
   app (where the Zesty connector previews them and places what the user
   approves there), the standing conditionals, the book, then the full report. It is a
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
Skip this step, and say so, when the run is unattended (`/daily-run
unattended`, a scheduled or `/loop` run, or no answer to the question below),
when `TODAY.orders.json` is empty, or when the Zesty connector is missing. The
phone page already carries the orders either way, as text the user can paste
into the Claude app. `/daily-run orders` runs this step alone on today's
report: sync Zesty first (`python3 scripts/preflight.py --no-sync` is not
enough; POST `/api/portfolio/sync-zesty`) so the open orders are current.

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
     file's `limitPrice`. A sale with `mustFill: true` is re-priced at 0.5%
     under the last regular-session price when that has moved since the report
     (`/api/prices` gives it, with any pre-market print beside it), so that an
     ordinary gap still fills it; say the new price in the table.
   - a BUY with `attachStop` becomes `preview_us_bracket_order` with
     `orderClass: "oto"`, `orderType: "limit"`, the limit price and
     `stopLoss: {stopPrice}`, `timeInForce: "gtc"` (the stop takes the order's
     duration, so a day order would lose its stop at the close). The stop
     starts to rest when the buy fills. Say in the table that the buy itself
     now rests until it fills or is cancelled. Placed outside regular hours
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
   A confirmed oto/bracket returns `legIds`: record each one at once with
   `pnpm exec tsx scripts/record-zesty-leg.ts <orderId> <legId> sell stop
   <qty> <stopPrice>`. Zesty's web API never lists a leg, so the sync sees
   its level only through that file (`.whatsapp/zesty-legs.json`); without
   it the stop shows as resting with its level unknown. Once a parent leaves
   the pending list, the next sync reads each of its known legs by id and
   writes the fill (or the end) in that file, where the trade journal finds
   the sale. The web API gives no fill time, so for an exact date record it
   from the connector's `get_order_detail` on the leg (its `fill` event):
   `pnpm exec tsx scripts/record-zesty-leg.ts fill <legId> <qty> <avgPrice>
   <filledAt>`.
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
- The last report's orders: which filled and at what price, which expired,
  and what the new report did with each.
- The orders offered in step 7: which were approved and now rest at Zesty,
  which were declined, rejected or left waiting for a fill.
