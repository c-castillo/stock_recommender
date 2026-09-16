# Technical Analysis – Explained: the full framework

Source: *Technical Analysis – Explained*, Credit Suisse Global Technical
Research and Behavioral Finance, Zurich —
`~/Downloads/1A_technical_tutorial_de.pdf` (34pp).

---

## What technical analysis is for

The framework's premise is that price action **pre-empts fundamental data**:
the market discounts economic news before it is published, so the chart turns
before the earnings or the macro print explains why.

Its second premise is behavioural — *"mood governs ratio."* Price cycles track a
psychological sequence: relief → hope → optimism → confidence → conviction →
euphoria → greed → denial → concern → caution → pessimism → fear → despondency →
panic. Sentiment extremes, not valuation, mark the turns.

---

## Chart types and horizons

OHLC bars at monthly, weekly, daily and hourly frequency. The clock metaphor:

| Chart | Trend | Metaphor |
|---|---|---|
| Monthly | Long-term / primary | Hours |
| Weekly | Medium-term / secondary | Minutes |
| Daily | Short-term | Seconds |

Trends nest inside one another. A primary uptrend is interrupted by secondary
corrections, which are themselves interrupted by short-term moves. Confusing the
degree of a move for a change in the primary trend is the most common error the
document warns about.

> "The best investment results are achieved when all three trends on the daily,
> weekly and monthly charts point in the same direction."

---

## Trend definitions

- **Uptrend** — higher peaks *and* higher troughs
- **Downtrend** — lower peaks *and* lower troughs
- **Sideways / consolidation** — horizontal peaks and troughs

---

## Support and resistance

Resistance is a horizontal line from a recent extreme price peak, projected
forward. Support is the same from a recent correction low.

- An uptrend continues as long as the most recent peak is surpassed and new
  peaks are reached.
- A downtrend continues as long as past lows are broken, sustaining lower lows
  and lower highs.
- **Previous support often becomes resistance, and resistance becomes support.**
- A level's importance — and the credibility of a break — **increases with the
  number of price extremes a single line connects.**

**Reversals:**

> "A bearish trend reversal occurs when the price breaks through the most recent
> support after failing to rise above the most recent resistance. A bullish trend
> reversal occurs when the price penetrates the most recent resistance after
> holding above the most recent support."

---

## Trendlines

A straight line through **at least three points**.

- Uptrend → connect the **lows**. Downtrend → connect the **highs**.
- **Must not be drawn over the price action** — the line must incorporate all
  the data.
- A line connecting only two extremes is of questionable validity.
- Credibility rises with the number of extremes connected.

**Break rules:** the trend is broken when price falls below an uptrend line or
rises above a downtrend line. Two common confirmations:

- the **2-day rule** — the close must be beyond the line for at least two days
- the **1% rule** — the close must be more than 1% beyond the line (use more in
  volatile markets)

The document's guidance on exits: *"Stay with a trend until it breaks, avoiding
the urge to sell too soon because the profit could be higher than you originally
thought."*

---

## Moving averages

CS plots **Fibonacci-number** averages: **21 / 55 / 144** days for short,
medium and long-term trend respectively.

**Three signal types:**

1. price crosses the moving average
2. the moving average itself changes direction
3. the moving averages cross each other

**Signal tiers:**

| Tier | Trigger | Confirmation |
|---|---|---|
| **B1 / S1** — trading | price crosses the 21-day | the 21-day itself turns |
| **B2 / S2** — tactical | price crosses the 55-day | 21 crosses 55, and the 55-day turns |
| **B3 / S3** — strategic | price crosses the 144-day | 55 crosses 144, and the 144-day turns |

The project playbook's `MM200 slope ↑ = long bias` is **signal type 2 at the
strategic tier**. It is a long-term statement and should not be used to justify
or veto short-term entries by itself.

---

## Momentum

A rate-of-change oscillator around a **zero line** — today's price versus the
price N periods ago. Positive above zero, negative below.

- **Overbought** — an extreme reading above zero. **Oversold** — an extreme
  below.
- The rubber-band principle: *"the further it stretches, the more the prices need
  energy to sustain the trend"* — reversal becomes more likely as the extreme
  deepens.
- **Divergence** is the highest-value signal: price posts a new high while the
  oscillator posts a lower high (or the inverse at lows). The new price extreme
  is unconfirmed. Divergence typically precedes the moving-average break.
- Constraint: *"once momentum provides a signal it has to be confirmed by a
  moving average crossover."*

Momentum is calculated at each horizon — daily, weekly, monthly — to match the
three averages.

---

## Trend and momentum combined

Pair each average with the momentum indicator of the same horizon:

- 21-day ↔ daily momentum
- 55-day ↔ weekly momentum
- 144-day ↔ monthly momentum

> "THE COMBINATION OF THESE SIX INDICATORS reveals the most likely future path of
> the underlying market in all asset classes."

**Most positive constellation:** price above the short-term average, which is
rising above the medium-term average, which is rising above the 144-day — and at
the same time daily, weekly and monthly momentum all rising. **Most negative** is
the exact inverse.

---

## Cycle quadrants and breadth

Momentum position and direction define four phases:

| Quadrant | Momentum state |
|---|---|
| **Up** | rising, below zero |
| **Advancing** | rising, above zero |
| **Down** | falling, above zero |
| **Terminating** | falling, below zero |

Applied across a basket this gives breadth. The document's Dow example: 5 stocks
(17%) up, 16 (53%) advancing, 7 (23%) down, 2 (7%) terminating. Percentages let
different portfolios and asset classes be compared.

**Vocabulary note:** this framework has no "Stage 1–4" — that is Weinstein's
scheme. Reports in this project have used "Stage-4 decline" as an unsourced label
to override a rising MM200. The correct term here is **terminating**, and it must
be backed by an actual momentum reading.

---

## Head and shoulders

Formed when an uptrend loses momentum, levels off, then establishes a downtrend.
Labelling the peaks 3 (left shoulder region / head build) → 4 (dip) → 5 (head) →
A (decline) → B (right shoulder rally):

- Volume **picks up** as higher highs are made into the head.
- The dip to 4 comes on **lighter volume** — still a correction at this stage.
- The rally to 5 on **diminishing volume** alerts the technician a top may be
  near.
- The fall to A breaks the uptrend line.
- The rally to B typically retraces **50% to 61.8%** of the 5→A decline — a
  Fibonacci relationship.
- B's failure to regain 5 fulfils **half** the reversal requirement (descending
  peaks).
- **Activation:** a closing break below the **neckline** (drawn under lows 4 and
  A) **on increased volume**. The neckline may slope either way or be horizontal.
- **Measured target:** the height of the head above the neckline (5 to A),
  projected down from the neckline break.

The **inverse** H&S works identically in the opposite direction.

**Caveat from the source:** waiting for the neckline break can be late if the
head formed at a highly overbought level. Elliott plus momentum gives an earlier
sell signal — when the five-wave uptrend tops and the correction starts showing
impulsive downside patterns — and Fibonacci correlations give more precision.

---

## The Elliott Wave Principle

Elliott's discovery of how crowd behaviour trends and reverses in recognisable
patterns. The crowd is psychological, not physical, moving from pessimism to
optimism, fear to greed, euphoria to panic.

Markets are **fractal**: patterns in daily snapshots resemble those in weekly,
monthly and yearly ones — a point Mandelbrot confirmed some fifty years after
Elliott proposed it in the 1930s.

Elliott isolated **thirteen patterns**, impulsive and corrective, which link
together at every degree of trend. The document catalogues impulsive waves and
corrective patterns separately.

The practical takeaway the document emphasises: **markets have form**, and that
form is where determinism can be found in an apparently random process.

---

## Fibonacci

The sequence: `1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987 …`

Ratios: any number to the next is **0.618**; to the next lower, **1.618**.
Between alternate numbers, **2.618** and its inverse **0.382**.

The identities the document highlights:

```
2.618 − 1.618 = 1        0.618 × 0.618 = 0.382
1 − 0.618 = 0.382        1.618 × 1.618 = 2.618
2.618 × 0.382 = 1
```

Note the same numbers drive the 21/55/144 moving averages. For retracement and
extension mechanics, anchoring and the levels themselves, use the
`fibonacci-charts` skill — it is built on a dedicated source.
