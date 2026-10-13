#!/usr/bin/env python3
"""How the reports' own calls have done since they were made.

  python3 scripts/scorecard.py [days=45]

Reads every `.whatsapp/reports/<date>.json` and `<date>.portfolio.json` in the
window and prices each call from the close of its report date to the latest
close. No model call. It prints Markdown for the 🩺 section of the next report:

  - orders: what was recommended, whether the book moved that way by the next
    report, and what the price did after
  - stances: held, watchlist and avoid names against SPY and SMH over the same
    days
  - confidence: whether a higher number went with a better outcome
  - the watchlist rows that have earned their removal

A call is counted once, from the first report that made it. Returns are price
only, and "right" means the price went the way the call said.
"""
import datetime as dt
import glob
import json
import os
import re
import sys

from marketdata import REPORTS, Closes, close_on, last

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 45
ORDER = re.compile(r"^(BUY|SELL)\s+([\d,.]+)\s*sh")
HEDGES = {"SSG", "SOXS", "PSQ", "QID", "SQQQ", "SH", "SDS", "BITI", "SEF", "ERY"}


def load():
    since = (dt.date.today() - dt.timedelta(days=DAYS)).isoformat()
    reports, books = {}, {}
    for f in sorted(glob.glob(os.path.join(REPORTS, "*.json"))):
        date = os.path.basename(f)[:10]
        if date < since:
            continue
        data = json.load(open(f))
        if f.endswith(".portfolio.json"):
            books[date] = {p["ticker"]: p["shares"] for p in data.get("positions", [])}
        elif "recommendations" in data:
            reports[date] = data["recommendations"]
    return reports, books


def pct(a, b):
    return 100 * (b / a - 1)


def avg(xs):
    return sum(xs) / len(xs) if xs else 0.0


def main():
    reports, books = load()
    if not reports:
        sys.exit("no reports in the window")
    dates = sorted(reports)
    closes = Closes()
    spy, smh = closes.of("SPY"), closes.of("SMH")

    first, seen, latest, orders = {}, {}, {}, []
    for date in dates:
        # A report with no snapshot of its own (the first ones) takes the nearest.
        near = sorted(books, key=lambda d: abs((dt.date.fromisoformat(d) - dt.date.fromisoformat(date)).days))
        book = books.get(date) or (books[near[0]] if near else {})
        for r in reports[date]:
            t, why = r["ticker"], r.get("reasoning", "")
            m = ORDER.match(why)
            held = t in book if book else not why.lower().startswith("not held")
            if m:
                orders.append((date, t, m.group(1), float(m.group(2).replace(",", "")), r["confidence"]))
            if t in HEDGES:
                stance = "hedge"
            elif held:
                stance = "held"
            elif r["action"] == "SELL":
                stance = "avoid"
            elif r["action"] == "BUY":
                stance = "buy, not held"
            else:
                stance = "watchlist"
            key = (t, stance)
            first.setdefault(key, (date, r["confidence"]))
            seen[key] = seen.get(key, 0) + 1
            latest[key] = date

    rows = []
    for (t, stance), (date, conf) in first.items():
        bars = closes.of(t)
        base, now = close_on(bars, date), last(bars)
        if not base or not now:
            continue
        rows.append({
            "t": t, "stance": stance, "date": date, "conf": conf, "ret": pct(base, now),
            "spy": pct(close_on(spy, date), last(spy)) if spy else 0.0,
            "smh": pct(close_on(smh, date), last(smh)) if smh else 0.0,
            "n": seen[(t, stance)], "last": latest[(t, stance)] == dates[-1],
        })
    closes.save()

    as_of = max(spy) if spy else dates[-1]
    print(f"## Scorecard: calls from {dates[0]} to {dates[-1]}, priced at the close of {as_of}")
    print(f"{len(dates)} reports. Price return from the close of the first report that made the call. "
          "A short window is noise: read direction, not decimals.\n")

    # ── orders ────────────────────────────────────────────────────────────────
    print("### Orders recommended")
    print("Date|Order|Conf|Book by next report|Price since|Right?")
    print("---|---|---|---|---|---")
    shown = set()
    for date, t, side, n, conf in orders:
        if (t, side) in shown:  # a repeated order is the same call, still open
            continue
        shown.add((t, side))
        later = [d for d in sorted(books) if d > date]
        if date in books and later:
            delta = books[later[0]].get(t, 0) - books[date].get(t, 0)
            moved = delta if side == "BUY" else -delta
            followed = f"{'bought' if side == 'BUY' else 'sold'} {moved:g} of {n:g}" if moved > 0 else "not taken"
        else:
            followed = "no later snapshot"
        bars = closes.of(t)
        base, now = close_on(bars, date), last(bars)
        if not base or not now:
            continue
        r = pct(base, now)
        right = (r > 0) == (side == "BUY") if abs(r) >= 0.5 else None
        repeats = sum(1 for o in orders if o[1] == t and o[2] == side)
        print(f"{date}|{side} {n:g} {t}{f' (×{repeats} reports)' if repeats > 1 else ''}|{conf}|{followed}|"
              f"{r:+.1f}%|{'flat' if right is None else 'yes' if right else 'no'}")
    if not orders:
        print("—|none|—|—|—|—")

    # ── stances ───────────────────────────────────────────────────────────────
    print("\n### By stance")
    print("Stance|Names|Avg price change|Went the call's way|SPY same days|SMH same days")
    print("---|---|---|---|---|---")
    for stance, direction in (("held", 1), ("watchlist", 1), ("avoid", -1), ("hedge", 0)):
        g = [r for r in rows if r["stance"] == stance]
        if not g:
            continue
        hit = "—" if direction == 0 else f"{sum(1 for r in g if r['ret'] * direction > 0)} of {len(g)}"
        print(f"{stance}|{len(g)}|{avg([r['ret'] for r in g]):+.1f}%|{hit}|"
              f"{avg([r['spy'] for r in g]):+.1f}%|{avg([r['smh'] for r in g]):+.1f}%")

    # ── confidence ────────────────────────────────────────────────────────────
    print("\n### Does confidence rank outcomes?")
    print("Confidence at first call|Calls|Avg return in the call's direction|Right")
    print("---|---|---|---")
    directional = [(r, 1 if r["stance"] in ("held", "watchlist", "buy, not held") else -1)
                   for r in rows if r["stance"] != "hedge"]
    for label, lo, hi in (("75 and over", 75, 101), ("60 to 74", 60, 75), ("45 to 59", 45, 60), ("under 45", 0, 45)):
        g = [(r, d) for r, d in directional if lo <= r["conf"] < hi]
        if g:
            print(f"{label}|{len(g)}|{avg([r['ret'] * d for r, d in g]):+.1f}%|"
                  f"{sum(1 for r, d in g if r['ret'] * d > 0)} of {len(g)}")

    # ── held names, worst first ───────────────────────────────────────────────
    held = sorted((r for r in rows if r["stance"] == "held"), key=lambda r: r["ret"])
    if held:
        print("\n### Held names since first reported (worst first)")
        print("Ticker|Since|Price change|SMH same days|Reports")
        print("---|---|---|---|---")
        for r in held:
            print(f"{r['t']}|{r['date']}|{r['ret']:+.1f}%|{r['smh']:+.1f}%|{r['n']}")

    # ── rows that should leave the daily table ────────────────────────────────
    stale = sorted((r for r in rows if r["stance"] == "watchlist" and r["n"] >= 4 and r["last"]),
                   key=lambda r: -r["n"])
    if stale:
        print("\n### Watchlist rows carried for four or more reports")
        print("Ticker|Reports|First seen|Price change|First confidence")
        print("---|---|---|---|---")
        for r in stale:
            print(f"{r['t']}|{r['n']}|{r['date']}|{r['ret']:+.1f}%|{r['conf']}")

    if closes.failed:
        print(f"\nNot priced: {', '.join(sorted(set(closes.failed)))}"
              + (" — Yahoo is rate-limiting; run again later, priced tickers are cached." if closes.blocked else ""))


if __name__ == "__main__":
    main()
