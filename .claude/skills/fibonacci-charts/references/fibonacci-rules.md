# Fibonacci in technical analysis — mechanics and best practice

Source: Tarek I. Saab, *An Introduction to Applying Fibonacci Ratios in
Technical Analysis*, fibonacci.com — the PDF Dr CS shared with the group. The
anchoring section quotes Constance Brown, *Fibonacci Analysis* (Bloomberg
Financial / Wiley), citing W.D. Gann.

---

## The sequence and the ratios

The sequence: `0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987 …`
— each number the sum of the previous two.

Dividing a number by the one preceding it converges on the golden ratio **Φ =
1.618**:

```
3/2 = 1.5    5/3 = 1.666    8/5 = 1.6    13/8 = 1.625
21/13 = 1.615    34/21 = 1.619    89/55 = 1.618
```

The inverse (55/89) gives **φ = 0.618**. Skipping a number (55/144, 144/55)
gives **0.382** and **2.618**.

**Retracement levels:** 0.236, 0.382, 0.500, 0.618, 0.786
**Extension levels:** 1.000, 1.618, 2.618, 4.236

Note 0.500 is not a Fibonacci ratio — it is conventional, and frequently
respected anyway.

---

## Retracements

Map the move from **1 at the starting point to 0 at the ending point**, then plot
the ratios between them. Standard application uses the pivot cycle high and pivot
cycle low of a period.

They describe price action *following a breakdown* from a cycle high: where a
pullback is likely to find support (or, inverted, where a bounce meets
resistance).

The source's S&P 500 illustration, 2007 peak → 2009 low:

- **A** — price finds support at 0.618 and bounces
- **B** — the retracement from the 2009 low reverses at that same 0.618
- **C** — a reversal stops at 0.382 and continues higher
- **D** — consolidation clusters at 0.786
- later — the next major resistance cluster lands on the **1.618 extension**

The same level acting first as support and later as resistance (A then B) is
normal and is part of why these levels are watched.

---

## Extensions

Where retracements look backward, **extensions project targets forward** after a
breakout above the prior cycle high. Depending on software, they are drawn
high→low or low→high; either way the bands should **exceed the recent cycle high
at 1.000** and extend to **1.618, 2.618, 4.236**.

Once a higher extension is breached, redraw from more recent pivot cycle highs
and lows.

This is the one part of the toolkit that is genuinely forward-looking — most
technical analysis is backward-looking by construction.

---

## Anchoring: the decisive judgement

Standard practice anchors at pivot cycle highs and lows. But Brown, citing Gann:

> "W.D. Gann stated in his stock course that he often found the secondary swing
> away from the actual bottom, or the secondary high after the end of a trend, to
> be of greater value than the actual price that ends the prior trend."

**Why:** blow-off tops, capitulation selloffs and one-off spikes are outlier
events in a chart's rhythm — *"they are the cymbals, not the base drum."*
Anchoring to an outlier produces levels the market never had reason to respect.

**Rule of thumb from the source:**

- Anchor at the **actual peak/trough** when it is **rounded** or sits in an area
  of **congestion**.
- Anchor at the **secondary** (or even tertiary) pivot when the extreme was a
  **rapid crescendo** — a spike, a blow-off, a capitulation.

### Case: TLT

Standard anchoring produced targets that "would appear to be completely
unreliable." Re-anchored at the **secondary high**, the same chart revealed a
pattern honouring the levels accurately.

### Case: AVB

With standard anchoring the chart looked **"sloppy"** — key peaks, troughs and
consolidation areas honoured none of the ratios. By the time price definitively
broke the prior cycle high the move was already underway, and an entry there had
poor reward/risk.

Re-anchored at **the shelf following the blow-off spike**, five key pivots and a
consolidation area aligned precisely. The **retest of the broken $193 shelf**
became the ideal entry — ahead of buyers waiting for the all-time-high breakout
near $199 — "dramatically" improving the reward/risk profile.

**The lesson to carry into every read:** sloppy-looking levels are usually an
anchoring problem, not evidence that Fibonacci fails on that chart.

---

## Scale: logarithmic vs arithmetic

The source: logarithmic scaling "tends to be more indicative of chart rhythm
than arithmetic scale, which often exaggerates aspects of the chart."

Note this is **contested inside the group** — a member argues *"en estricto rigor
Fibo se debe aplicar en aritmético."* Report which scale a chart uses; do not
present either convention as settled.

---

## Time-based tools

### Fibonacci Time Zones

Vertical bands at Fibonacci intervals measured along the x-axis, anchored at a
price peak or trough. The first five numbers cluster too tightly to be useful and
can be ignored.

| Zone | Periods |
|---|---|
| 8th | 21 |
| 9th | 34 |
| 10th | 55 |
| 11th | 89 |
| 12th | 144 |
| 13th | 233 |

Pivots in price may occur around these periods.

### Fibonacci Time Ratios

The same idea applied as *ratios* rather than fixed periods, producing vertical
bands at 0.382 / 0.618 / 1.618 / 2.618 of the measured span. Applied more like
retracements and extensions than like time zones.

---

## Fans

Fans measure **both time and price**. Retracements and extensions ignore how long
a move took; a fan's slope depends on it — the faster the move, the steeper the
lines.

**Rising fan** (from a pivot cycle low to a pivot cycle high):

1. Plot retracement levels from the pivot low to the pivot high — horizontal
   bands in descending order (23.6% above 38.2%).
2. Draw a diagonal from the pivot low to where each horizontal band intersects a
   vertical line through the pivot high.

**Falling fan** — used during corrective patterns; the inverse:

1. Plot retracement levels from the pivot high to the pivot low — bands in
   ascending order (38.2% above 23.6%).
2. Draw a diagonal from the pivot high to where each band intersects a vertical
   through the pivot low.

Slope `m = (y − y₁) / (x − x₁)`. The diagonals act as dynamic support/resistance.

---

## Arcs

Measured from pivot low to pivot high (or the reverse). The straight line between
them sets the measurement length; arc radii are plotted along it at **23.6%,
38.2%, 50%, 78.6%**. The arcs act as hypothetical support and resistance,
accounting for both time and price.

---

## Best practice and honest limits

- Fibonacci levels are **not predictors**. They "help to establish and improve
  probabilities, particularly when used in combination with other market
  indicators." Used alone they are weakest.
- Criticism of reliability usually reflects **misapplication** — most technicians
  plot peak-to-trough, see nothing, and conclude it does not work.
- The source explicitly does **not** use Elliott Wave, though the two are
  commonly associated. Fibonacci here stands independent of wave counting.
- Applying the tools is "just as much art as science." The camera metaphor: the
  objective is to bring the picture into focus, not merely to take the photo.
  Adjusting the anchor is adjusting the lens.
