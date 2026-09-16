---
name: fibonacci-charts
description: Read and interpret Fibonacci retracements, extensions, fans, arcs and time zones on charts Dr CS shares in the WhatsApp groups, and turn them into a directional call the playbook can use. Use when asked about Fibonacci, fib levels, retracements, extensions, 0.618 / 0.786 / 1.618, golden ratio, anchoring a fib, or price targets derived from a fib.
---

# Reading Dr CS's Fibonacci charts

The playbook makes this the primary method: *"Primary setup: Big Bases
(**Fibonacci main**, Demark secondary)."* A Fibonacci read is not corroboration
here — it is the setup. DeMark sharpens the timing on top of it.

## The ratios

**Retracements** — drawn between a swing high and a swing low, mapping 1 at the
start to 0 at the end:

`0.236 · 0.382 · 0.500 · 0.618 · 0.786`

**Extensions** — targets beyond the prior cycle high, once price breaks out:

`1.000 · 1.618 · 2.618 · 4.236`

0.618 is the golden ratio's inverse (φ); 1.618 is Φ. 0.382 and 2.618 come from
skipping a number in the sequence. 0.500 is not a Fibonacci ratio at all but is
conventionally plotted and often respected.

Retracements look *backwards* (where does a pullback find support). Extensions
look *forwards* (where does the next leg terminate) — the one genuinely
predictive part of the toolkit.

## The part that actually matters: where the fib is anchored

Most of the value, and nearly all the disagreement, is in **anchor choice**. The
same chart yields completely different levels depending on where you start.

**Standard practice** anchors at the pivot cycle high and pivot cycle low.

**But** — per Connie Brown, citing W.D. Gann, and endorsed by the source
document:

> The secondary swing away from the actual bottom, or the secondary high after
> the end of a trend, is often of greater value than the actual price that ends
> the prior trend.

**When to prefer the secondary pivot:** the actual extreme was a **blow-off top,
a capitulation selloff, or a one-off spike**. Those are outliers in the chart's
rhythm — *"the cymbals, not the base drum."*

**When the actual extreme is fine:** the peak is **rounded**, or sits in an area
of **congestion**, rather than being a rapid crescendo.

The document's worked cases: on **TLT**, standard anchoring produced targets
that looked completely unreliable; re-anchoring at the secondary high made the
chart honour the levels. On **AVB**, the standard fib looked "sloppy" — no
pivots respected — until it was anchored at the *shelf following the blow-off
spike*, after which five pivots and a consolidation zone aligned precisely.

**So when a chart's levels look sloppy, do not conclude "Fibonacci doesn't work
here." Ask whether it is anchored at an outlier spike**, and say so. That is the
single most useful judgement this skill can contribute.

The AVB case also carries the trade lesson: the *retest* of the broken secondary
high ($193) was the entry, not the eventual breakout of the all-time high
(~$199). Anchoring well finds entries earlier and with better reward/risk.

## Reading a chart

- **Identify the anchors first.** Find the two points the fib is drawn from and
  say whether they are cycle extremes or secondary pivots. If you cannot tell,
  say so — every level below depends on it.
- **Direction.** Retracement levels descending from a high = a pullback in an
  uptrend (support below). Ascending from a low = a bounce in a downtrend
  (resistance above).
- **Which levels price actually respected** — bounces, rejections, consolidation
  clusters sitting on a line. A level tested and held is evidence; a level price
  sailed through is not.
- **Extensions above the prior high** — 1.618 and 2.618 are the target cluster.
- **Confluence** — a fib level coinciding with a moving average, a prior
  structural high/low, a TDST line or a round number is materially stronger than
  a fib level alone.
- **Scale.** Note whether the chart is log or arithmetic; it changes the levels.
  See *Group conventions* below — this is contested.

## The three-skill stack

Dr CS's methodology is these three used together, in order:

1. **`technical-analysis`** — the frame. Horizon, trend, support/resistance,
   21/55/144 moving averages, momentum and divergence. Run this on EVERY chart.
2. **`fibonacci-charts`** — *where*. The playbook's primary setup.
3. **`demark-charts`** — *when*. Exhaustion timing.

A count or a level read without first establishing the trend and the horizon is
how a correction gets written up as a reversal.

## Confluence with DeMark

The two skills are designed to be used together, and the playbook orders them:
Fibonacci defines *where*, DeMark defines *when*.

The strongest setup available in this methodology is a **DeMark 9 or 13 landing
on a Fibonacci level** — exhaustion arriving exactly at a structural price. When
you see both, say so explicitly and raise confidence. Use the `demark-charts`
skill for the count side; the `★ DeMark:` and `◈ Fib:` lines in the media digest
block make the overlap easy to spot.

## Workflow

1. **Find the charts.** `media_digests` (MCP, `stock-recommender`) — Fibonacci
   levels are extracted into a `◈ Fib:` line under each chart.
   `search_messages` with `fibo`, `retroceso`, `extension`, `618` finds the
   discussion; Dr CS is usually asked to explain his anchoring.
2. **Verify against the image.** The digest line is a pointer, not gospel —
   levels are small text and anchors are often ambiguous. Open `media_path` with
   the Read tool before acting on a number.
3. **Establish the anchors**, then read the levels off them.
4. **Check confluence** — other studies, MAs, structure, DeMark counts.
5. **Combine with the playbook**, then state the call.

## Turning it into a call

| Evidence | Weight |
|---|---|
| Price reacting at 0.618 or 0.786 with confluence, plus a DeMark 9/13 | Strongest |
| Multiple prior pivots on the same fib grid (the anchor is "in focus") | Strong — the levels are being honoured |
| A clean bounce/rejection at a single fib level | Moderate |
| Levels drawn from a blow-off spike, pivots not respected | Weak — re-anchor before concluding anything |
| An extension target with no breakout yet | Not actionable — it is a target, not a signal |

Then apply the project's standing rules, which outrank this skill:

- **MM200 slope governs bias.** ↑ = long bias, ↓ = avoid/short. A 0.618 bounce
  on an MM200-negative name is not a long.
- **An active Dr CS ADD outranks a bearish fib read.** Check `dr_cs_adds`; never
  SELL a ticker with a live ADD.
- **Cite the dated chart** per the playbook's evidence discipline.
- **Price the present.** Fib levels from an old chart go stale — quote entries
  and stops against live `quotes`.
- Fibonacci **improves probabilities; it does not predict**. The source is blunt
  that these are not forecasts, and are weakest used alone.

## Output

```
GFS · daily · retracement anchored 2023 high → 2025 low (cycle extremes, rounded top — OK)
  Chart: Dr CS, 2026-04-02 · 0.382 = 41.20 · 0.500 = 44.80 · 0.618 = 48.40
  Respected: rejected twice at 0.382; consolidating beneath it
  Confluence: 0.618 sits on the 2024 structural high — strong overhead
  Playbook: MM200 ↓ → resistance read stands; no long here
```

Say plainly when the anchoring is ambiguous or the levels are unreadable.
Guessing at a level is worse than reporting that you could not read it.

## Group conventions and one live disagreement

- Dr CS is the group's fib authority (*"Ud es el capo en fibo doc"*), and members
  regularly ask **how he anchors** — e.g. *"cuando hace esas estimaciones las
  hace con fibonacci desde el punto más alto del gráfico?"* Anchoring is the
  recurring question; answer it explicitly whenever you read a chart.
- Retracement direction is discussed as **"va de 1 a 0"** — 1 at the start
  anchor, 0 at the end, matching the source document.
- **Log vs arithmetic is contested.** A member states *"en estricto rigor Fibo se
  debe aplicar en aritmético"*, while the source document argues logarithmic
  scaling better reveals a chart's rhythm and that arithmetic exaggerates. Do
  not present either as settled — state which scale the chart uses and note the
  levels shift under the other.
- Extensions are used as live targets in-group (e.g. *"si pierde los 62k en
  cierre semanal podría irse al 1.618"*), including to the downside.
- Watch for typos in chat: **61.6** appears where **61.8** is meant.

## Detail

Full mechanics — retracements, extensions, time zones, time ratios, fans, arcs,
and the best-practice section on anchoring — are in
`references/fibonacci-rules.md`.

## Source

Tarek I. Saab, *An Introduction to Applying Fibonacci Ratios in Technical
Analysis* (fibonacci.com), shared by Dr CS as
`~/Downloads/Dr CS_Introduction to Fibonacci copy.pdf`. Quotes Constance Brown,
*Fibonacci Analysis* (Bloomberg/Wiley), on secondary-pivot anchoring.
