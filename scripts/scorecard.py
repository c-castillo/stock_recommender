#!/usr/bin/env python3
"""How the reports' own calls have done since they were made.

  python3 scripts/scorecard.py [days=45] [--review]

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
only, and "right" means the price went the way the call said. Two reports
written on the same closes (a re-run, or a run after midnight) are one report:
the newer one. Whether an order was taken, and at what price, comes from the
broker's fills when a sync has stored them.

`--review` adds the rule review: what the stops, sales, buys and hedges that
actually filled in the last 90 days made or lost, in dollars. It is the
evidence a change to the playbook has to stand on.
"""
import datetime as dt
import glob
import json
import os
import re
import sys

from marketdata import CASH_APR, COMMISSION_PC, HEDGES, REPORTS, Closes, api, close_on, last, load as read_json

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
DAYS = int(ARGS[0]) if ARGS else 45
REVIEW = "--review" in sys.argv
REVIEW_DAYS = 90
ORDER = re.compile(r"^(BUY|SELL)\s+([\d,.]+)\s*sh")


def load():
    """Reports and book snapshots of the window, keyed by the session whose
    closes they were written on. A report with no `.run.json` beside it (those
    written before the run recorded its session) is keyed by its own date."""
    since = (dt.date.today() - dt.timedelta(days=DAYS)).isoformat()
    reports, books = {}, {}
    for f in sorted(glob.glob(os.path.join(REPORTS, "*.json"))):
        name = os.path.basename(f)
        date, kind = name[:10], name[10:]
        if date < since or kind not in (".json", ".portfolio.json"):
            continue
        session = (read_json(os.path.join(REPORTS, f"{date}.run.json"), {}) or {}).get("session") or date
        data = json.load(open(f))
        # Files sort by date, so a later report on the same session replaces
        # the earlier one instead of counting as a second call.
        if kind == ".portfolio.json":
            books[session] = {p["ticker"]: p["shares"] for p in data.get("positions", [])}
        elif "recommendations" in data:
            reports[session] = data["recommendations"]
    return reports, books


def broker_fills():
    """Every filled order the syncs have seen, by id: the live read when the
    dashboard is up, plus the copy each run saved beside its report."""
    seen = {}
    for f in sorted(glob.glob(os.path.join(REPORTS, "*.broker-orders.json"))):
        for o in (read_json(f, {}) or {}).get("closed", []):
            seen[o["id"]] = o
    try:
        for o in (api("/api/portfolio", timeout=5).get("orders") or {}).get("closed", []):
            seen[o["id"]] = o
    except Exception:
        pass
    return sorted((o for o in seen.values() if o["filledQty"] > 0), key=lambda o: o["createdAt"])


def taken(fills, ticker, side, date, days=6):
    """(shares, average price) the broker filled for a call in the days after it."""
    until = (dt.date.fromisoformat(date) + dt.timedelta(days=days)).isoformat()
    hit = [o for o in fills if o["ticker"] == ticker and o["side"] == side.lower() and date <= o["createdAt"][:10] <= until]
    qty = sum(o["filledQty"] for o in hit)
    return (qty, sum(o["filledQty"] * (o.get("filledAvgPrice") or 0) for o in hit) / qty) if qty else (0, None)


def pct(a, b):
    return 100 * (b / a - 1)


def avg(xs):
    return sum(xs) / len(xs) if xs else 0.0


def main():
    reports, books = load()
    fills = broker_fills()
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
          "A short window is noise: read direction, not decimals.")
    span = (dt.date.fromisoformat(as_of) - dt.date.fromisoformat(dates[0])).days
    print(f"Costs: {100 * COMMISSION_PC:.2f}% commission per side; cash earned "
          f"{100 * ((1 + CASH_APR) ** (span / 365) - 1):.2f}% over these {span} days "
          f"({100 * CASH_APR:.1f}% a year), the return of doing nothing.\n")

    # ── orders ────────────────────────────────────────────────────────────────
    print("### Orders recommended")
    print("Date|Order|Conf|Taken (broker fills)|Price since|After commissions|Right?|Not taking it")
    print("---|---|---|---|---|---|---|---")
    shown, skipped = set(), 0.0
    for date, t, side, n, conf in orders:
        if (t, side) in shown:  # a repeated order is the same call, still open
            continue
        shown.add((t, side))
        bars = closes.of(t)
        base, now = close_on(bars, date), last(bars)
        if not base or not now:
            continue
        got, fill = taken(fills, t, side, date)
        later = [d for d in sorted(books) if d > date]
        if got:
            followed = f"{'bought' if side == 'BUY' else 'sold'} {got:g} of {n:g} at ${fill:,.2f}"
        elif fills and fills[0]["createdAt"][:10] <= date:
            followed = "not taken"
        elif date in books and later:
            delta = books[later[0]].get(t, 0) - books[date].get(t, 0)
            got = max(delta if side == "BUY" else -delta, 0)
            followed = f"{'bought' if side == 'BUY' else 'sold'} {got:g} of {n:g}" if got > 0 else "not taken"
        else:
            followed = "no later snapshot"
        r = pct(fill or base, now)
        right = (r > 0) == (side == "BUY") if abs(r) >= 0.5 else None
        repeats = sum(1 for o in orders if o[1] == t and o[2] == side)
        # A buy pays both sides before it has made anything; a sale pays one
        # side and is worth what the price then fell.
        net = r - 200 * COMMISSION_PC if side == "BUY" else -r - 100 * COMMISSION_PC
        # The shares the call asked for and the broker never traded: what that
        # has cost (a sale skipped before a fall, a buy skipped before a rise).
        left = max(n - got, 0) if followed != "no later snapshot" else 0
        miss = left * base * pct(base, now) / 100 * (1 if side == "BUY" else -1)
        skipped += miss
        print(f"{date}|{side} {n:g} {t}{f' (×{repeats} reports)' if repeats > 1 else ''}|{conf}|{followed}|"
              f"{r:+.1f}%|{net:+.1f}% {'gained' if side == 'BUY' else 'saved'}|"
              f"{'flat' if right is None else 'yes' if right else 'no'}|"
              f"{'—' if abs(miss) < 1 else f'cost ${miss:,.0f}' if miss > 0 else f'saved ${-miss:,.0f}'}")
    if not orders:
        print("—|none|—|—|—|—|—|—")
    elif abs(skipped) >= 1:
        print(f"\nOrders not taken, or taken in part, have {'cost' if skipped > 0 else 'saved'} "
              f"${abs(skipped):,.0f} in all at today's closes.")

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

    if REVIEW:
        review(fills, closes, smh)

    if closes.failed:
        print(f"\nNot priced: {', '.join(sorted(set(closes.failed)))}"
              + (" — Yahoo is rate-limiting; run again later, priced tickers are cached." if closes.blocked else ""))


def review(fills, closes, smh):
    """What the trades that filled have made or lost, by the rule behind them."""
    since = (dt.date.today() - dt.timedelta(days=REVIEW_DAYS)).isoformat()
    window = [o for o in fills if o["createdAt"][:10] >= since and o.get("filledAvgPrice")]
    print(f"\n### Rule review: fills since {since}")
    if not window:
        print("No fills on record yet: the Zesty sync stores them from now on.")
        return
    groups = {"Stops that fired": [], "Other sales": [], "Buys": [], "Hedges bought": []}
    for o in window:
        px = last(closes.of(o["ticker"]))
        if not px:
            continue
        amount = o["filledQty"] * o["filledAvgPrice"]
        move = px / o["filledAvgPrice"] - 1
        day = o["createdAt"][:10]
        bench = pct(close_on(smh, day), last(smh)) / 100 if smh and close_on(smh, day) else 0.0
        if o["ticker"] in HEDGES:
            if o["side"] == "buy":
                groups["Hedges bought"].append((o, amount * move - amount * 2 * COMMISSION_PC, move, bench))
        elif o["side"] == "buy":
            groups["Buys"].append((o, amount * move - amount * 2 * COMMISSION_PC, move, bench))
        else:
            name = "Stops that fired" if "stop" in o["type"] else "Other sales"
            # A sale is worth what the price fell after it, less its commission.
            groups[name].append((o, -amount * move - amount * COMMISSION_PC, move, bench))
    print("Rule|Fills|$ traded|Result after commissions|Went its way|What it means")
    print("---|---|---|---|---|---")
    meaning = {
        "Stops that fired": "positive: the stops got out before more damage; negative: they sold before a recovery",
        "Other sales": "positive: trims and exits were sold higher than today",
        "Buys": "what the entries are worth today, both commissions paid",
        "Hedges bought": "what the inverse ETFs made or lost, before what the trim they replaced would have saved",
    }
    for name, rows in groups.items():
        if not rows:
            continue
        traded = sum(o["filledQty"] * o["filledAvgPrice"] for o, *_ in rows)
        result = sum(r for _, r, *_ in rows)
        won = sum(1 for _, r, *_ in rows if r > 0)
        print(f"{name}|{len(rows)}|${traded:,.0f}|{result:+,.0f} $ ({100 * result / traded:+.1f}%)|{won} of {len(rows)}|{meaning[name]}")
    print("\nSent|Fill|Price now|Since|SMH same days|Result")
    print("---|---|---|---|---|---")
    for name, rows in groups.items():
        for o, result, move, bench in rows:
            print(f"{o['createdAt'][:10]}|{o['side'].upper()} {o['filledQty']:g} {o['ticker']} at ${o['filledAvgPrice']:,.2f}"
                  f"{' (stop)' if 'stop' in o['type'] else ''}|${last(closes.of(o['ticker'])):,.2f}|{100 * move:+.1f}%|"
                  f"{100 * bench:+.1f}%|{result:+,.0f} $")
    paid = sum(o["filledQty"] * o["filledAvgPrice"] for o in window) * COMMISSION_PC
    print(f"\nCommissions paid on these fills: ${paid:,.2f}.")
    # A purchase soon after a sale of the same name (or the reverse) paid two
    # commissions to end up where it started.
    turns = []
    for i, a in enumerate(window):
        for b in window[i + 1:]:
            gap = (dt.date.fromisoformat(b["createdAt"][:10]) - dt.date.fromisoformat(a["createdAt"][:10])).days
            if a["ticker"] == b["ticker"] and a["side"] != b["side"] and gap <= 28 and a["ticker"] not in HEDGES:
                turns.append(f"{a['ticker']} {a['side']} {a['createdAt'][:10]} then {b['side']} {b['createdAt'][:10]}")
                break
    if turns:
        print("Reversed inside 20 trading days: " + "; ".join(turns) + ".")
    print("A handful of fills is not a sample: name the rule that the numbers question, and wait for more before changing it.")


if __name__ == "__main__":
    main()
