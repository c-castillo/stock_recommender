---
name: technical-analysis
description: Read any price chart using the Credit Suisse technical framework Dr CS teaches — trend structure, support/resistance, trendlines, the 21/55/144 moving averages, momentum and divergence, cycle quadrants, and reversal patterns. Invoke this for EVERY chart, then layer fibonacci-charts and demark-charts on top. Use when a chart, screenshot or price graph appears, or when asked about trend, support, resistance, trendlines, moving averages, momentum, divergence, overbought/oversold, head and shoulders, or Elliott waves.
---

# Reading a chart the Dr CS way

The source is Credit Suisse's own primer, *Technical Analysis – Explained*
(Global Technical Research and Behavioral Finance, Zurich) — the house
methodology behind the "Dr CS" name. Together with Fibonacci and DeMark it is
the trio the group actually trades.

**Use all three, in this order, on every chart:**

| Skill | Answers | Role |
|---|---|---|
| **`technical-analysis`** (this one) | *What is the chart doing?* | The frame — trend, structure, momentum |
| **`fibonacci-charts`** | *Where?* | The levels — the playbook's primary setup |
| **`demark-charts`** | *When?* | The timing — exhaustion counts |

Never skip straight to a fib level or a DeMark count. Establish the trend and
the horizon first, or you will read a 9 on a chart whose primary trend makes it
irrelevant.

## 1. Fix the horizon before anything else

CS's clock metaphor: **daily = seconds (short-term), weekly = minutes
(medium-term), monthly = hours (long-term).**

> "The best investment results are achieved when all three trends on the daily,
> weekly and monthly charts point in the same direction."

State which timeframe you are reading. A daily downtrend inside a rising monthly
trend is a correction, not a reversal — and the opposite mistake is how a
pullback gets written up as a collapse. The `multi_timeframe_analysis` tool
measures exactly this alignment.

Trends nest: **primary** (long, the hours) → **secondary** (medium, the minutes)
→ short-term. A primary uptrend is never a straight line; it is interrupted by
secondary corrections.

## 2. Name the trend

- **Uptrend** — higher peaks **and** higher troughs
- **Downtrend** — lower peaks **and** lower troughs
- **Sideways / consolidation** — horizontal peaks and troughs

Both conditions must hold. "Higher highs but also lower lows" is not an uptrend;
it is a broadening range.

## 3. Support and resistance

Horizontal lines drawn from recent extremes — resistance from a price peak,
support from a correction low — projected forward.

- **Previous support becomes resistance, and resistance becomes support.**
- A level gains importance with **the number of extremes a single line
  connects**. A line through one peak is weak; through four, it matters.
- An uptrend continues while price surpasses past peaks and holds above past
  lows. A downtrend continues while it breaks past lows and fails at past highs.

**Reversal definitions — use these exact words, they are precise:**

> A **bearish** reversal occurs when price breaks the most recent support *after
> failing to rise above* the most recent resistance.
> A **bullish** reversal occurs when price penetrates the most recent resistance
> *after holding above* the most recent support.

## 4. Trendlines

- At least **three** points. A line through two is questionable.
- Connect **lows in an uptrend**, **highs in a downtrend**.
- Must **not be drawn over price action** — it has to contain all the data.
- **Break confirmation:** the 2-day rule (two closes beyond the line) or the
  1% rule (a close more than 1% beyond, wider in volatile markets). An intrabar
  poke is not a break.
- More connected extremes = a more credible line.

CS's advice on holding: *"Stay with a trend until it breaks, avoiding the urge
to sell too soon."*

## 5. Moving averages — 21 / 55 / 144

CS uses **Fibonacci numbers** for its averages, which is why this framework and
the fib work sit together so naturally:

| Average | Horizon | Signal tier |
|---|---|---|
| 21-day | short-term | trading (B1/S1) |
| 55-day | medium-term | tactical (B2/S2) |
| 144-day | long-term | strategic (B3/S3) |

**Three distinct signal types — do not conflate them:**

1. price crosses the moving average
2. **the moving average itself changes direction**
3. the moving averages cross each other

Signal hierarchy, with confirmation:

- **B1** price rises above the 21-day → confirmed when the 21-day itself turns up
- **B2** price breaks above the 55-day → confirmed when 21 crosses above 55 **and**
  the 55-day turns up
- **B3** price rises above the 144-day → confirmed when 55 crosses above 144
  **and** the 144-day turns up

Sell signals mirror exactly.

**This is where the playbook's MM200 rule comes from.** "MM200 slope ↑ = long
bias" is signal type 2 at the strategic tier. So an MM200 slope reading is a
*long-term* signal — it does not license a short-term entry on its own, and a
short-term break does not overturn it.

## 6. Momentum

Rate-of-change around a **zero line**: positive when price is above where it was
N periods ago.

- **Overbought** — oscillator at an extreme above zero; **oversold** — extreme
  below zero.
- The rubber-band principle: *"the further it stretches, the more the prices
  need energy to sustain the trend"* — expect reversal as the stretch grows.
- **Divergence is the high-value signal**: price makes a new high, the oscillator
  makes a lower high → the move is unconfirmed. This front-runs the moving-average
  break and is the earliest warning the framework offers.
- A momentum signal *"has to be confirmed by a moving average crossover."*
  Momentum alone is not a trade.

## 7. The six-indicator combination

Pair each average with the momentum indicator of its own horizon:

- 21-day + **daily** momentum
- 55-day + **weekly** momentum
- 144-day + **monthly** momentum

> The most positive constellation: price above the short-term average, which is
> rising above the medium-term average, which is rising above the 144-day —
> **and at the same time** daily, weekly and monthly momentum all rising.

The most negative constellation is the exact inverse. Anything else is mixed;
say so rather than forcing a direction.

## 8. Cycle quadrants — the correct vocabulary

Momentum position defines four phases:

| Quadrant | Momentum |
|---|---|
| **Up** | rising, below zero |
| **Advancing** | rising, above zero |
| **Down** | falling, above zero |
| **Terminating** | falling, below zero |

Use these words. **"Stage 4 decline" is not from this framework** — that is
Weinstein's vocabulary, and it was previously used in this project's reports as
an unsourced label to override a rising MM200. If you mean a stock whose
momentum is falling below zero, say **terminating**, and show the momentum
reading that supports it.

Across a basket, the distribution of quadrants gives breadth — e.g. of 30 Dow
stocks, 17% up / 53% advancing / 23% down / 7% terminating.

## 9. Reversal patterns

**Head and shoulders** — the best-known reversal:

- Volume picks up into the head; the rally to the right shoulder comes on
  **diminishing volume** — the first alert.
- The B rally after the initial break typically retraces **50%–61.8%** of the
  decline (a Fibonacci relationship — cross-check with `fibonacci-charts`).
- Failure of the right shoulder to regain the head fulfils **half** the reversal
  requirement (descending peaks).
- Activation requires a **closing break below the neckline on increased volume**.
- **Measured target** = the height of the head above the neckline, projected down
  from the neckline break.
- Inverse H&S works identically in reverse.

CS's own caveat: waiting for the neckline can be late if the head formed deeply
overbought — Elliott and Fibonacci give an earlier exit.

## 10. Elliott, briefly

Markets are **fractal** — patterns on daily snapshots resemble those on weekly,
monthly and yearly. Elliott catalogued thirteen patterns, impulsive and
corrective, driven by crowd psychology cycling from fear to greed.

Treat wave counts as context, not as a signal you act on alone. Where the group
discusses ABC corrections and wave targets, the Fibonacci relationships are the
tradeable part — see `fibonacci-charts`.

## Reading procedure

1. **Horizon** — which timeframe is this chart? Check daily/weekly/monthly
   alignment.
2. **Trend** — peaks and troughs: up, down, or sideways?
3. **Structure** — support and resistance levels, and how many touches each has.
4. **Trendlines** — drawn on ≥3 points? Broken by the 2-day or 1% rule?
5. **Moving averages** — price vs each MA, each MA's own direction, any crossovers.
   Which tier (B1/B2/B3) is signalling?
6. **Momentum** — quadrant, overbought/oversold, and above all **divergence**.
7. **Patterns** — H&S or other reversal formations, with measured targets.
8. **Then layer** `fibonacci-charts` for levels and `demark-charts` for timing.
9. **Apply the playbook** — MM200 bias, active Dr CS ADDs, evidence discipline.

## Turning it into a call

| Constellation | Read |
|---|---|
| All three horizons aligned, price above rising 21>55>144, momentum rising | Strongest long |
| Trend intact but momentum diverging | Warning — the move is unconfirmed |
| Price below a falling 144-day, momentum terminating | Strongest short/avoid |
| Timeframes conflicting | No trade. Say so — do not manufacture a direction |

The project's standing rules still outrank this skill: **MM200 slope governs
bias**, an **active Dr CS ADD is never overridden by a bearish chart read**, cite
the dated chart, and quote entries and stops from live `quotes` rather than
stale chart levels.

Technical analysis here is explicitly *"an art not a science"* — when a chart is
ambiguous, report it as ambiguous rather than resolving it by assertion.

## Detail

Full framework — chart construction, the momentum maths, cycle distribution,
Elliott's pattern catalogue and the Fibonacci identities — is in
`references/ta-framework.md`.

## Source

*Technical Analysis – Explained*, Credit Suisse Global Technical Research and
Behavioral Finance, Zurich — `~/Downloads/1A_technical_tutorial_de.pdf`.
