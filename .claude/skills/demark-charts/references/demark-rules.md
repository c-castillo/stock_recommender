# DeMARK TD Sequential and TD Combo — exact rules

Primary source: Jason Perl, *DeMark Indicators* (Bloomberg Press, 2008),
chapters 1–2. Cross-checked against the DeMARK 9-13 TradingView script
description and the group's Spanish summary (see *Known errors* at the end).

TD Sequential runs in two phases. **Setup** counts to 9 and defines the trend.
**Countdown** counts to 13 and identifies exhaustion. Countdown begins from the
close of Setup bar nine (inclusive) onward.

---

## Phase 1 — TD Setup (the 9)

Compares each close to the close **four bars earlier**.

- **Buy Setup** — nine consecutive closes *less than* the close four bars
  earlier. Plotted **below** the bars. A downtrend exhausting → potential
  reversal **upward**.
- **Sell Setup** — nine consecutive closes *greater than* the close four bars
  earlier. Plotted **above** the bars. An uptrend exhausting → potential
  reversal **downward**.

> **Colour is platform-specific.** TradingView plots both in blue. Bloomberg's
> `demark` study and Symbolik — what Dr CS posts — use green below for buy and
> red above for sell. Position relative to the bars is the reliable
> discriminator.

"Consecutive" is strict: one bar breaking the condition restarts the count at 1.

**A TD Setup can extend beyond bar nine** if no TD Price Flip extinguishes it.
Counts of 15, 22, 35 are a setup still running, and they mean the trend has not
flipped — evidence *against* an imminent reversal. This also matters for the
recycle qualifiers below, which compare setup ranges: an extended setup's range
includes those extra bars.

**TD Price Flip** — the change of direction between Buy and Sell Setup
sequences; price stops closing below (or above) the close of four bars earlier,
invalidating the active Setup and enabling the opposite one.

Display: once the count reaches 9, most platforms hide counts 1–8. A bare 9 with
no 1–8 leading into it is normal.

### Setup Perfection

- **Buy Setup**: the low of bars **eight or nine, or a subsequent low**, must be
  **less than or equal to** the lows of bars six *and* seven.
- **Sell Setup**: the high of bars **eight or nine, or a subsequent high**, must
  be **greater than or equal to** the highs of bars six *and* seven.

Note "or a subsequent" — perfection can arrive *after* bar nine. Until it does,
perfection is deferred and **the risk is a retest of the bar 6/7 extreme first**.

A perfected setup implies a minimum response of a **one- to four-bar
consolidation or reversal**.

The absence of Sell Setup perfection does **not** delay the onset of a Sell
Countdown — it only matters to someone trading the setup itself.

**Bloomberg draws perfection arrows** (up-arrow for a perfected Buy Setup,
down-arrow for a perfected Sell Setup) — check those before counting bars.

---

## TDST (TD Setup Trend) levels

The true price extreme of the completed setup, which redefines the range:

- **TDST resistance** = the **highest true high** of the completed **Buy Setup**
- **TDST support** = the **lowest true low** of the completed **Sell Setup**

Perl's framing: each completed Setup recalculates what counts as a range
extreme, and the market's response to that level determines the underlying
directional bias. Holding TDST = reversal/consolidation. Closing beyond it =
trend extension.

**Only closing breaks count.** An intrabar violation of a TDST level is not
significant; what matters is whether the market sustains the break on a closing
basis.

Rendering: solid = qualified, dashed = disqualified.

---

## TD Risk Level

The price beyond which the signal is dead — and the natural stop.

- **Buy Setup**: identify the setup bar with the **lowest true low**; subtract
  that bar's **true range** from its true low.
- **Sell Setup**: identify the setup bar with the **highest true high**; add
  that bar's **true range** to its true high.

**Perl's trade filter.** Take the trade only if the difference between the entry
price (the close of setup bar nine) and TDST is **more than 1.5 times** the
difference between that close and the risk level.

---

## Phase 2 — TD Sequential Countdown (the 13)

Begins from the close of Setup bar nine onward.

- **Buy**: close **less than or equal to** the low **two bars earlier**.
- **Sell**: close **greater than or equal to** the high **two bars earlier**.
- Counts **need not be consecutive** (unlike Setup).
- Minimum **12 bars beyond the 9**.

### Completing a Buy Countdown — both conditions

1. The **low of countdown bar thirteen** must be ≤ the **close of countdown bar
   eight** (the "13 vs. 8" rule), **and**
2. The **close of bar thirteen** must be ≤ the **low two bars earlier**.

Sell Countdown mirrors this: the **high of bar thirteen** ≥ the **close of bar
eight**, and the close of bar thirteen ≥ the high two bars earlier.

**When these fail, the thirteen is deferred and a `+` appears** where the 13
would have been. A `+` is not a 13; the count is still open. An optional
stricter variant uses 8 vs. 5.

**Intersection** is a further optional rule that delays the start of Countdown
to avoid false signals during extreme or atypical moves.

---

## Countdown Cancellation

Either condition erases an incomplete **Buy** Countdown:

1. Price rallies and generates a **TD Sell Setup**, or
2. The market posts a **true low above TDST resistance** (the true high of the
   prior TD Buy Setup).

Sell Countdown mirrors: an opposing Buy Setup completes, or a true high posts
below TDST support.

---

## Recycle qualifiers

`R` appears on the chart when a countdown recycles. Perl's qualifiers are more
specific than "a new setup appeared":

**Qualifier I** — compare the true range (highest true high to lowest true low)
of the most recently completed Setup against the previous Setup:

> If the new Setup's true range is **≥ the previous Setup's but less than 1.618
> times** its size, a Setup recycle occurs — whichever Setup has the **larger
> true range becomes the active Setup**.

**Qualifier II — a Setup within a Setup** — if the new Setup's closing range
falls **within** the prior Setup's true range, with no opposing Setup between
them, and its price extreme is also within that prior true range, then the
**prior Setup stays active and its Countdown remains intact**.

Remember that a Setup can extend past bar nine, which changes the true range
being compared.

---

## TD Combo — how it differs

Same Setup phase. The Countdown differs:

- **TD Sequential** waits for the Setup to complete, *then* starts looking for
  countdown conditions.
- **TD Combo** waits for the Setup to finish, then counts **retrospectively from
  bar one of that Setup**. It can therefore complete in as few as **four bars
  beyond the 9**.

Combo also requires **four conditions simultaneously**, not one.

**Combo Buy Countdown, Version I (strict):**

1. Close ≤ the low two price bars earlier;
2. Each countdown bar's low ≤ the low of the prior price bar;
3. Each countdown close < the previous countdown close; and
4. Each countdown close < the close of the prior price bar.

Version II is the less-strict variant.

**Character, and why both matter:**

- **Sequential** works across all market types (trending or consolidating) and
  tends to catch **intermediate reversals or pauses**.
- **Combo** is more selective, works better in trends, and targets the
  **extreme** — the top of a rally or the floor of a decline.
- **When Sequential and Combo align, the signal is materially stronger.**

---

## Interpretation cautions

- **Timeframe is part of the signal.** A daily 9 and a weekly 9 are separate
  observations and must not be merged. Always state which chart you read.
- **9 warns, 13 confirms.** The 9 says the trend is tiring; the 13 says
  exhaustion is fulfilled.
- **Exhaustion is not direction.** These mark where a move is likely to stall or
  turn; they do not forecast how far the counter-move runs.
- These are decision-support tools, not a trading system. No signal here
  overrides the project playbook's MM200 rule or an active Dr CS ADD.

---

## Known errors in the group's Spanish summary

`~/Downloads/DeMark - Resumen - VS - 20260124.pdf` is a useful 7-page summary
circulating in the group, but two points are wrong — prefer the book:

1. **Perfected Sell Setup** is stated as bar 8/9's high being *inferior* (below)
   the highs of bars 6 and 7. It must be **above**. As written it inverts the
   rule.
2. Its worked example gives **TDST = 106**, taken from a bar *outside* the nine
   setup bars, contradicting the definition the same document gives one page
   earlier. By that definition the TDST there would be 100.

Its Sequential/Combo character description and its countdown-deferral wording
are accurate and genuinely useful.
