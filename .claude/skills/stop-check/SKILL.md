---
name: stop-check
description: The light run for market hours — sync the Zesty portfolio and print each holding against the stop of the last published report, plus the open orders at the broker. No agents, no analysis, nothing published.
disable-model-invocation: true
---

# Stop check: Zesty → prices against stops

For any moment between two daily runs. It answers one question: is anything at
or under its stop, and is that stop resting at the broker? It writes no report,
changes no recommendation and publishes nothing. No API credits and no agents.

1. Dashboard up: `curl -sf localhost:3000/api/whatsapp/status`. If it does not
   answer, start `pnpm dev` with `run_in_background: true` and wait for it.
2. `curl -s -m 180 -X POST localhost:3000/api/portfolio/sync-zesty`. On a 502
   say the login failed and go on with the stored portfolio.
3. Open orders, with the claude.ai Zesty connector: `get_orders` with
   `status: "pending"`. Read-only tools only; never call a `preview_*` or
   `confirm_*` tool. If the connector is missing, say so and skip this.
4. `python3 scripts/stop-check.py`.

Report back, in this order:

- Anything under its stop or within 2% of it. A stop written as a close is a
  warning until 16:00 New York and an exit after it; say which it is.
- The table.
- Held longs with no stop resting at Zesty, from step 3, with the stop the last
  report gave for each. The user places orders; this skill never does.
- Positions or cash that changed since the last report's snapshot
  (`.whatsapp/reports/*.portfolio.json`, the newest), with the fills.

A trailing stop in the report is a percentage from the high since entry. The
script shows the level the report printed, so when the price has made a new
high since, say that the real level is higher. Don't recommend a trade the last
report did not contain: a fired stop is reported, and the decision waits for
the evening run unless the report already said what to do when it fires.
