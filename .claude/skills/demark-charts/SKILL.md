---
name: demark-charts
description: Read and interpret DeMARK TD Sequential 9 and 13 counts on charts Dr CS shares in the WhatsApp groups, and turn them into a directional call the playbook can use. Use when asked about DeMark, TD Sequential, TD Combo, a "9" or "13" on a chart, setup/countdown, perfection, TDST levels, risk levels, or exhaustion signals.
---

# Reading Dr CS's DeMARK charts

Dr CS posts charts carrying DeMARK TD Sequential counts — the numbers running
above and below the bars, with 9 and 13 as the ones that matter. This skill
turns those into a directional read.

The playbook already names DeMark: *"Primary setup: Big Bases (Fibonacci main,
Demark secondary)."* So a DeMark count is **corroborating evidence, not a
standalone thesis**. It sharpens timing on a setup that Fibonacci or a big base
already justifies.

## The one thing people get backwards

**A "Buy Setup 9" is bullish. A "Sell Setup 9" is bearish.** The name describes
the *bar sequence being counted*, not the action. A Buy Setup counts nine bars
of weakness — it is the *downtrend* exhausting, which is why it precedes an
*upward* reversal. Get this wrong and every read inverts.

| On the chart | Means | Direction |
|---|---|---|
| 9 **below** the bars | Buy Setup complete — nine closes below the close 4 bars earlier | **Bullish** — downside exhausting |
| 9 **above** the bars | Sell Setup complete — nine closes above the close 4 bars earlier | **Bearish** — upside exhausting |
| 13 **below** the bars | Buy Countdown complete | **Bullish**, higher conviction than the 9 |
| 13 **above** the bars | Sell Countdown complete | **Bearish**, higher conviction than the 9 |

## Reading the chart itself

**Position, not colour.** Colour is platform-specific and will mislead you. The
TradingView script plots both setups in blue. Dr CS posts Bloomberg (`demark`
study) and Symbolik, which use **green below for buy** and **red above for
sell**. Always check which side of the price the number sits on.

**Perfection arrows.** Bloomberg marks a perfected setup with an **arrow** —
up-arrow under a perfected Buy Setup, down-arrow over a perfected Sell Setup
(Perl: *"can be seen by checking the TD Setup perfection arrows"*). Other
renderings put a dot above the 9. An arrow is the fastest way to tell a
perfected 9 from an unperfected one without counting bars yourself.

**Counts running past 9 are meaningful, not clutter.** A TD Setup **keeps
extending beyond bar nine if no TD Price Flip extinguishes it**, so a Bloomberg
chart showing 10, 15, 22, 35 is telling you the trend never flipped and the
setup is still running. A long extension is evidence of a *strong, intact
trend* — the opposite of exhaustion. Do not dismiss those numbers, and do not
treat the eventual 9 as stale just because the count continued.

**`+` is a deferred 13**, not a 13. **`R` is a recycle** — the prior 13 is void.

## Workflow

1. **Find the charts.** `media_digests` (MCP, `stock-recommender`) lists cached
   chart summaries. `search_messages` with `demark`, `combo`, `sequential`, `13`
   finds the surrounding discussion — Dr CS usually comments on what he posted.
2. **Check the ★ DeMark line, then verify against the image.** Digests now
   always carry a `demark` field: Haiku triages every chart, and any chart it
   flags as carrying counts is re-read by Sonnet (`refineDemark` in
   `lib/ai/media-digest.ts`). It renders as a `★ DeMark:` line under the chart.
   Treat that line as a reliable *pointer*, not gospel — dense charts crowd the
   digits, and the escalation exists precisely because Haiku once reported
   "no active Sell Setup" on a chart carrying a Sell Countdown to 13. Before
   acting on a count, open `media_path` with the Read tool and confirm the side
   and the number yourself.
3. **Extract** ticker, timeframe, count and position, perfection arrow, any
   `+`/`R`, TDST lines, risk level.
4. **Interpret** using `references/demark-rules.md` — it carries the exact
   completion, cancellation and recycle conditions from Perl's book.
5. **Combine with the playbook**, then state the call.

## The three-skill stack

Dr CS's methodology is these three used together, in order:

1. **`technical-analysis`** — the frame. Horizon, trend, support/resistance,
   21/55/144 moving averages, momentum and divergence. Run this on EVERY chart.
2. **`fibonacci-charts`** — *where*. The playbook's primary setup.
3. **`demark-charts`** — *when*. Exhaustion timing.

A count or a level read without first establishing the trend and the horizon is
how a correction gets written up as a reversal.

## Confluence with Fibonacci

The playbook orders these: *"Big Bases (Fibonacci main, Demark secondary)."*
Fibonacci defines **where** a reversal should happen; DeMark defines **when**.

The strongest setup in this methodology is a **9 or 13 landing on a Fibonacci
level** — exhaustion arriving exactly at a structural price. When a chart shows
both, say so explicitly and raise confidence. The media digest block makes the
overlap visible: `★ DeMark:` and `◈ Fib:` lines sit under the same chart. Use
the `fibonacci-charts` skill for the level side.

## The quantitative part

Two levels are *calculated*, not eyeballed. If the chart shows the bars clearly
enough, derive them; otherwise say you could not.

**TDST** — the true price extreme of the completed setup:
- Buy Setup → **TDST resistance** = highest true high of the nine setup bars
- Sell Setup → **TDST support** = lowest true low of the nine setup bars

A TDST break only counts **on a closing basis**. Perl is explicit that an
intrabar violation is not significant.

**TD Risk Level** — the invalidation price, and the natural stop:
- Buy Setup → take the setup bar with the **lowest true low**, subtract that
  bar's **true range** from its true low
- Sell Setup → take the setup bar with the **highest true high**, add that
  bar's **true range** to its true high

**Perl's trade filter.** Enter only if the distance from entry to TDST is more
than **1.5×** the distance from entry to the risk level, where entry is the
close of setup bar nine. This is a concrete gate — apply it before calling
anything actionable, and say so when a setup fails it.

## Turning it into a call

| Evidence | Weight |
|---|---|
| Perfected 13, price respecting the risk level, Sequential and Combo aligned | Strongest — exhaustion fulfilled |
| Perfected 13 | Strong — expect a response within ~12 bars |
| Perfected 9 | Moderate — expect a turn or stall within 1–4 bars |
| Unperfected 9 | Weak — a warning; risk of a retest of bar 6/7's extreme first |
| `+` deferral, `R` recycle, or a cancelled countdown | Not a signal. Say so explicitly |
| Setup still extending past 9 with no price flip | Trend intact — argues *against* the reversal |

Then apply the project's standing rules, which outrank this skill:

- **MM200 slope governs bias.** ↑ = long bias, ↓ = avoid/short. A Sell 13 on a
  name with MM200 ↑ is a reason to trim or wait, **not** to flip short. Use
  `quotes` to check the slope before writing a direction.
- **An active Dr CS ADD outranks a bearish count.** Check `dr_cs_adds`. The ADD
  rule is explicit: never SELL a ticker with a live ADD. A Sell 9/13 against an
  active ADD is a caution to report, not an exit.
- **Cite the dated chart.** Under the playbook's evidence discipline, name the
  chart and its date. "DeMark says sell" with no dated source is not usable.
- **Price the present.** Read levels off the chart, but quote entries and stops
  from the live price via `quotes` — chart levels go stale.

## Output

```
CIEN · daily · Sell Setup 9 (perfected — down-arrow above bar 9)
  Chart: Dr CS, 2026-09-04 · TDST support 318 · Risk level 352 (high 344 + TR 8)
  Filter: entry 331 → TDST 318 is 13pts; entry → risk 21pts. 0.6x < 1.5x — FAILS
  Read: upside exhausting, but reward/risk does not qualify per Perl
  Playbook: MM200 ↑+5.5%, no active ADD → trim only, do not short
```

State plainly when a chart is ambiguous. A count you cannot read is not a
signal, and guessing at a blurry number is worse than reporting it unreadable.

## Worked example — QQQ, Bloomberg `demark Daily`, shared 2026-05-06

From the corpus, to calibrate:

- Green counts **below** the bars into the June low completing a Buy Setup, with
  a marker at the low → downside exhausted, price reversed up.
- Red counts **above** the bars through the July rally reaching a red 13 → Sell
  Countdown complete. Price stalled and chopped sideways for weeks after.
- Counts continuing into the 20s and 30s → the setup extending with no price
  flip, i.e. trend still intact.
- Green horizontal lines (one solid ~115.84, one dotted lower) → TDST levels.
- A `+` among the later counts → deferral; the count was still open there.

What the pipeline makes of it now, after the digest fix:

> Buy Countdown 13 perfected below bars at June low (marked with arrow); Buy
> Setup counts 1–9 visible in May–June; Sell Setup 1–13 visible above bars
> Aug–Sep but not perfected; TDST support line at ~115.

Both sides reported. Before the DeMark field existed the same chart digested as
"bullish, support 115.84" with the Sell 13 nowhere in the record.

## Sources

- Jason Perl, *DeMark Indicators* (Bloomberg Press, 2008), ch. 1–2 — the
  authority for every rule in `references/demark-rules.md`.
- `~/Downloads/DeMark - Resumen - VS - 20260124.pdf` — a Spanish summary
  circulating in the group. Useful, but it carries **two errors**: it states a
  Perfected Sell Setup needs bar 8/9's high *below* bars 6–7 (it must be
  *above*), and its worked example uses a TDST of 106 taken from a bar outside
  the setup, contradicting its own definition. Prefer the book.
- <https://www.tradingview.com/script/gVMuxasg-DeMARK-9-13/>
