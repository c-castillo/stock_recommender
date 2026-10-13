#!/usr/bin/env python3
"""Where each holding stands against the stop of the last published report.

  python3 scripts/stop-check.py

The light run for market hours: no agents, no report, nothing published. It
reads the stops from the newest `.whatsapp/reports/<date>.json`, the holdings
and buying power from the dashboard (`/api/portfolio`, as left by the last
Zesty sync) and live prices from `/api/prices`, and prints one table.

A stop written as a close ("daily close < $212") is only decided at 16:00 New
York; before that a price under it is a warning, not an exit. A trailing
percentage is measured from the high since the report, which this script does
not track: it shows the level the report printed.
"""
import datetime as dt
import glob
import json
import os
import re
import sys
import urllib.request

from marketdata import REPORTS

BASE = os.environ.get("DASHBOARD_URL", "http://localhost:3000")
LEVEL = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)")
HEDGES = {"SSG", "SOXS", "PSQ", "QID", "SQQQ", "SH", "SDS", "BITI", "SEF", "ERY"}


def api(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as res:
        return json.load(res)


def main():
    files = sorted(f for f in glob.glob(os.path.join(REPORTS, "*.json")) if not f.endswith(".portfolio.json"))
    if not files:
        sys.exit("no report to read stops from")
    report = os.path.basename(files[-1])[:10]
    recs = {r["ticker"]: r for r in json.load(open(files[-1]))["recommendations"]}

    try:
        book = api("/api/portfolio")
    except Exception as e:
        sys.exit(f"dashboard not answering at {BASE} ({e}): start it with `pnpm dev`")
    positions = book.get("positions", [])
    tickers = [p["ticker"] for p in positions]
    prices = api("/api/prices?tickers=" + ",".join(tickers)) if tickers else {}
    prices = prices.get("prices", prices)

    ny = dt.datetime.now(dt.timezone.utc).astimezone(__import__("zoneinfo").ZoneInfo("America/New_York"))
    minutes = ny.hour * 60 + ny.minute
    if ny.weekday() >= 5:
        session = "market closed (weekend)"
    elif minutes < 570:
        session = "pre-market"
    elif minutes < 960:
        session = "market open"
    else:
        session = "after the close"
    print(f"## Stop check, {ny:%a %d-%m %H:%M} New York, {session}")
    print(f"Stops from the report of {report}. Prices live from the dashboard.\n")
    print("Ticker|Shares|Price|Stop in the report|Level|Distance|Status")
    print("---|---|---|---|---|---|---")

    alerts = []
    for p in sorted(positions, key=lambda p: -(p.get("market_value") or 0)):
        t = p["ticker"]
        px = prices.get(t) or p.get("current_price")
        stop = (recs.get(t) or {}).get("stopLoss") or ""
        m = LEVEL.search(stop)
        if t in HEDGES:
            # A hedge has an exit condition on its underlying, not a stop on its own price.
            print(f"{t}|{p['shares']:g}|{f'${px:.2f}' if px else '—'}|{stop or '—'}|—|—|hedge: read the exit")
            continue
        if not px or not m:
            print(f"{t}|{p['shares']:g}|{f'${px:.2f}' if px else '—'}|{stop or 'none in the report'}|—|—|no level")
            continue
        level = float(m.group(1).replace(",", ""))
        gap = 100 * (px / level - 1)
        on_close = bool(re.search(r"close", stop, re.I))
        if gap < 0:
            decided = not on_close or session in ("after the close", "market closed (weekend)")
            status = "BELOW: stop fired" if decided else "BELOW: waits for the close"
            alerts.append(f"{t} ${px:.2f} is {abs(gap):.1f}% under ${level:,.2f} ({status.split(': ')[1]})")
        elif gap < 2:
            status = "within 2%"
            alerts.append(f"{t} ${px:.2f} is {gap:.1f}% above ${level:,.2f}")
        else:
            status = "ok"
        print(f"{t}|{p['shares']:g}|${px:.2f}|{stop}|${level:,.2f}|{gap:+.1f}%|{status}")

    cash, free = book.get("cash_balance"), book.get("buying_power")
    if cash is not None:
        line = f"\nCash ${cash:,.2f}"
        if free is not None and cash - free > 0.5:
            line += f", of which ${cash - free:,.2f} is reserved by open buy orders"
        print(line)
    print("\n" + ("Needs attention: " + "; ".join(alerts) if alerts else "Nothing within 2% of its stop."))


if __name__ == "__main__":
    main()
