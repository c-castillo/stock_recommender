#!/usr/bin/env python3
"""Check a report's numbers against the market and the book, then publish it.

  python3 scripts/publish-check.py 2026-10-14            # check only
  python3 scripts/publish-check.py 2026-10-14 --publish  # check, back up, publish, verify

Reads `.whatsapp/reports/<date>.{md,json,orders.json}`. The checks are the
same every night, which is the point of having them in a script:

  shape      every row has a ticker, BUY|SELL|HOLD, a numeric confidence and a reasoning
  prices     a BUY's or a held SELL's entry price is within 2% of the market
  amounts    shares × price matches the $ the order states, within 2%
  book       no sale for more shares than are held; buys fit in buying power;
             every held ticker has a row
  earnings   no BUY of a name whose results fall within three sessions, and no
             BUY of a company with no date checked at all
  risk       no BUY loses more than the risk budget between its entry and its stop
  orders     the orders file agrees with the rows, and a sale that must fill is
             priced to fill

A failed check prints FAIL and nothing is published (exit code 1). `--publish`
then backs up the live recommendations, replaces them, verifies the dashboard
took them and saves the book snapshot for tomorrow's diff.
"""
import datetime as dt
import json
import os
import re
import sys

from marketdata import HEDGES, REPORTS, RISK_PER_POSITION, ROOT, api, load

MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")
ORDER = re.compile(r"^(BUY|SELL)\s+([\d,.]+)\s*sh\s*[≈=~]\s*\$\s*([\d,]+(?:\.\d+)?)")
ETFS = {"SMH", "SOXX", "SPY", "QQQ", "IGV", "GLD", "SLV", "TLT", "XLK", "XLC", "XLY", "XLF", "XLE", "XLI",
        "XLB", "XLU", "XLP", "XLV", "XLRE", "IBIT", "EWY", "UUP", "KORU", "RSP"}
# A sale the rules require is priced under the last price so that it fills.
MUST_FILL_DISCOUNT = 0.005


def first_money(text):
    m = MONEY.search(text or "")
    return float(m.group(1).replace(",", "")) if m else None


def check_shape(recs):
    bad = []
    if not recs:
        return ["no recommendations"]
    for r in recs:
        t = r.get("ticker") or "?"
        if not r.get("ticker"):
            bad.append("a row has no ticker")
        if r.get("action") not in ("BUY", "SELL", "HOLD"):
            bad.append(f"{t}: action is {r.get('action')!r}")
        if not isinstance(r.get("confidence"), (int, float)):
            bad.append(f"{t}: confidence is not a number")
        if not isinstance(r.get("reasoning"), str) or not r["reasoning"].strip():
            bad.append(f"{t}: no reasoning")
    return bad


def check_prices(recs, held, prices):
    bad = []
    for r in recs:
        t = r["ticker"]
        if r["action"] == "HOLD" or (r["action"] == "SELL" and t not in held):
            continue
        entry, px = first_money(r.get("entryPrice")), prices.get(t)
        if entry is None:
            bad.append(f"{t}: {r['action']} with no $ entry price")
        elif px and abs(entry / px - 1) > 0.02:
            bad.append(f"{t}: entry ${entry:,.2f} is {100 * (entry / px - 1):+.1f}% from the market's ${px:,.2f}")
    return bad


def check_amounts(recs):
    bad = []
    for r in recs:
        m = ORDER.match(r.get("reasoning") or "")
        entry = first_money(r.get("entryPrice"))
        if not m or not entry:
            continue
        shares, stated = float(m.group(2).replace(",", "")), float(m.group(3).replace(",", ""))
        if stated and abs(shares * entry / stated - 1) > 0.02:
            bad.append(f"{r['ticker']}: {shares:g} sh × ${entry:,.2f} = ${shares * entry:,.0f}, the row says ${stated:,.0f}")
    return bad


def order_rows(recs):
    """(ticker, side, shares, entry) for the rows that are orders."""
    out = []
    for r in recs:
        m = ORDER.match(r.get("reasoning") or "")
        if m:
            out.append((r["ticker"], m.group(1), float(m.group(2).replace(",", "")), first_money(r.get("entryPrice"))))
    return out


def check_book(recs, held, power):
    bad = []
    rows = order_rows(recs)
    for t, side, shares, _ in rows:
        if side == "SELL" and shares > held.get(t, 0) + 1e-6:
            bad.append(f"{t}: SELL {shares:g} sh but {held.get(t, 0):g} are held")
    sold = sum(s * (e or 0) for _, side, s, e in rows if side == "SELL")
    bought = sum(s * (e or 0) for _, side, s, e in rows if side == "BUY")
    if power is not None and bought > power + sold + 1:
        bad.append(f"buys cost ${bought:,.0f}: buying power is ${power:,.0f} plus ${sold:,.0f} from this report's sales")
    missing = sorted(set(held) - {r["ticker"] for r in recs})
    if missing:
        bad.append("held with no row: " + ", ".join(missing))
    return bad


def sessions_until(day, today):
    """Trading days from today up to `day`, weekends skipped (holidays are not known)."""
    n, d = 0, today
    while d < day:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def check_earnings(recs, held, calendar, today):
    """`calendar` is {ticker: date} for the BUY names, or None when it could not be read."""
    bad, notes = [], []
    buys = [r["ticker"] for r in recs if r["action"] == "BUY" and ORDER.match(r.get("reasoning") or "")]
    if not buys:
        return bad, notes
    if calendar is None:
        return ["the earnings calendar could not be read: a BUY cannot be checked against its results date"], notes
    for t in buys:
        day = calendar.get(t)
        if day is None:
            notes.append(f"{t}: no results in the next 21 days")
            continue
        away = sessions_until(day, today)
        if away <= 3 and t not in held:
            bad.append(f"{t}: BUY opens a position {away} session(s) before its results on {day:%a %d-%m}")
        elif away <= 3:
            notes.append(f"{t}: results on {day:%a %d-%m}, {away} session(s) away — adding needs a main-analyst ADD refreshed this session")
        else:
            notes.append(f"{t}: results on {day:%a %d-%m}, {away} sessions away")
    return bad, notes


def check_risk(recs, total):
    bad = []
    if not total:
        return bad
    budget = total * RISK_PER_POSITION
    for r in recs:
        m = ORDER.match(r.get("reasoning") or "")
        if not m or m.group(1) != "BUY" or r["ticker"] in HEDGES:
            continue
        shares, entry, stop = float(m.group(2).replace(",", "")), first_money(r.get("entryPrice")), first_money(r.get("stopLoss"))
        if not entry or not stop:
            bad.append(f"{r['ticker']}: BUY with no stop level to size it against")
        elif stop < entry and shares * (entry - stop) > budget * 1.1:
            bad.append(f"{r['ticker']}: {shares:g} sh lose ${shares * (entry - stop):,.0f} at the ${stop:,.2f} stop; "
                       f"the budget is ${budget:,.0f} ({100 * RISK_PER_POSITION:.2f}% of the book), "
                       f"{int(budget // (entry - stop))} sh")
    return bad


def check_orders(recs, orders, held, prices):
    bad = []
    rows = {(t, side.lower()): s for t, side, s, _ in order_rows(recs)}
    listed = {(o["ticker"], o["side"]): o for o in orders if o.get("source") != "stop"}
    for key, shares in rows.items():
        o = listed.get(key)
        if not o:
            bad.append(f"{key[1].upper()} {shares:g} {key[0]} is in the report but not in the orders file")
        elif abs(o["qty"] - shares) > 1e-6:
            bad.append(f"{key[0]}: the report says {shares:g} sh, the orders file {o['qty']:g}")
    for key in listed:
        if key not in rows:
            bad.append(f"{key[1].upper()} {key[0]} is in the orders file but is not an order row of the report")
    sells = {}
    for o in orders:
        if o["side"] == "sell":
            sells.setdefault(o["ticker"], []).append(o)
        px = prices.get(o["ticker"])
        if o.get("mustFill") and o["side"] == "sell" and o.get("limitPrice") and px and o["limitPrice"] > px * (1 - MUST_FILL_DISCOUNT / 2):
            bad.append(f"{o['ticker']}: a sale that must fill is priced at ${o['limitPrice']:,.2f}, not under the market's "
                       f"${px:,.2f}: it expires unfilled if the stock opens lower")
    for t, group in sells.items():
        if not any(o.get("waitsFor") for o in group) and t not in held:
            bad.append(f"{t}: the orders file sells a ticker that is not held")
    return bad


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    date = args[0] if args else dt.date.today().isoformat()
    path = lambda kind: os.path.join(REPORTS, f"{date}.{kind}")  # noqa: E731
    data = load(path("json"))
    if data is None or not os.path.exists(path("md")):
        sys.exit(f"FAIL: {path('json')} or its .md is missing or not JSON")
    recs = data.get("recommendations") or []
    orders = (load(path("orders.json"), {}) or {}).get("orders", [])

    book = api("/api/portfolio")
    held = {p["ticker"]: p["shares"] for p in book.get("positions", [])}
    power = book.get("buying_power") if book.get("buying_power") is not None else book.get("cash_balance")
    total = sum(p.get("market_value") or 0 for p in book.get("positions", [])) + (book.get("cash_balance") or 0)

    shape = check_shape(recs)
    results = [("shape", shape)]
    if not shape:
        tickers = sorted({r["ticker"] for r in recs if r["action"] != "HOLD"} | set(held))
        prices = api("/api/prices?tickers=" + ",".join(tickers)).get("prices", {}) if tickers else {}
        buys = [r["ticker"] for r in recs if r["action"] == "BUY" and r["ticker"] not in ETFS | HEDGES
                and ORDER.match(r.get("reasoning") or "")]
        calendar = {}
        if buys:
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                from events import earnings
                calendar = {t: v[0] for t, v in earnings(buys).items()}
            except Exception:
                calendar = None
        earn, notes = check_earnings([r for r in recs if r["ticker"] not in ETFS | HEDGES], held, calendar, dt.date.today())
        results += [
            ("prices", check_prices(recs, held, prices)),
            ("amounts", check_amounts(recs)),
            ("book", check_book(recs, held, power)),
            ("earnings", earn),
            ("risk", check_risk(recs, total)),
            ("orders", check_orders(recs, orders, held, prices)),
        ]
    else:
        notes = []

    failed = False
    for name, bad in results:
        print(f"{'FAIL' if bad else 'ok  '} {name}" + ("" if not bad else ": " + "; ".join(bad)))
        failed = failed or bool(bad)
    for n in notes:
        print(f"     {n}")
    if failed:
        print("\nNot published. Fix the report or ask the user.")
        return 1
    if "--publish" not in sys.argv:
        print(f"\nAll checks passed for {date}: {len(recs)} rows, {len(orders)} orders. Not published (no --publish).")
        return 0

    before = api("/api/recommendations")
    backups = os.path.join(ROOT, ".whatsapp", "recs-backups")
    os.makedirs(backups, exist_ok=True)
    backup = os.path.join(backups, dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
    json.dump(before, open(backup, "w"))
    posted = api("/api/recommendations", {"recommendations": recs, "narrative": open(path("md")).read(), "date": date}, timeout=120)
    after = api("/api/recommendations")
    live = after.get("recommendations", after if isinstance(after, list) else [])
    problems = []
    if len(live) != len(recs):
        problems.append(f"the dashboard holds {len(live)} rows, the report has {len(recs)}")
    if posted.get("wikiUpdated") not in (None, len(recs)):
        problems.append(f"wikiUpdated is {posted.get('wikiUpdated')}, expected {len(recs)}")
    for key in ("generatedAt", "narrativeAt"):
        if isinstance(before, dict) and before.get(key) is not None and before.get(key) == after.get(key):
            problems.append(f"{key} did not change")
    json.dump(api("/api/portfolio"), open(path("portfolio.json"), "w"))
    print(f"\nPublished {len(recs)} rows for {date}. Backup: {backup}. Snapshot: {path('portfolio.json')}.")
    if problems:
        print("FAIL after publishing: " + "; ".join(problems))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
