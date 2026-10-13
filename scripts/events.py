#!/usr/bin/env python3
"""Earnings dates and news headlines the WhatsApp corpus does not carry.

  python3 scripts/events.py CIEN MU NBIS …            # earnings + headlines
  python3 scripts/events.py --no-news CIEN MU …       # earnings only

Earnings: Nasdaq's public calendar, read day by day for the next 21 calendar
days (one request per day, whatever the number of tickers), so a print inside
the window is known before it happens. Headlines: Google News, last three
days, at most four per ticker. No key, no model call.

A headline is a pointer, not a report: it says why a stock moved, it does not
qualify a RESEARCH BUY. Company names for the search come from the newest
report's JSON when the ticker is in it.
"""
import datetime as dt
import glob
import html
import json
import os
import re
import sys
import time
import urllib.parse

from marketdata import REPORTS, get

AHEAD_DAYS = 21
WHEN = {"time-pre-market": "before the open", "time-after-hours": "after the close", "time-not-supplied": "time not given"}


def earnings(tickers):
    wanted, found = set(tickers), {}
    today = dt.date.today()
    for i in range(AHEAD_DAYS + 1):
        day = today + dt.timedelta(days=i)
        if day.weekday() >= 5:
            continue
        try:
            data = json.loads(get(f"https://api.nasdaq.com/api/calendar/earnings?date={day}"))
            rows = (data.get("data") or {}).get("rows") or []
        except Exception as e:
            print(f"  (calendar for {day} unavailable: {e})")
            continue
        for r in rows:
            sym = (r.get("symbol") or "").upper()
            if sym in wanted and sym not in found:
                found[sym] = (day, WHEN.get(r.get("time"), "time not given"), r.get("epsForecast") or "—")
        time.sleep(0.15)
    return found


def names():
    files = sorted(f for f in glob.glob(os.path.join(REPORTS, "*.json")) if not f.endswith(".portfolio.json"))
    if not files:
        return {}
    recs = json.load(open(files[-1])).get("recommendations", [])
    return {r["ticker"]: r.get("company") for r in recs if r.get("company")}


def headlines(ticker, company):
    # A bare ticker is often a word ("MU", "BE", "ON"); the company name is not.
    q = f'"{company}" stock when:3d' if company else f"{ticker} stock when:3d"
    url = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=" + urllib.parse.quote(q)
    xml = get(url, accept="application/rss+xml")
    items = re.findall(r"<item><title>(.*?)</title>.*?<pubDate>(.*?)</pubDate>", xml, re.S)
    out = []
    for title, when in items:
        try:
            stamp = dt.datetime.strptime(when.strip(), "%a, %d %b %Y %H:%M:%S %Z")
        except ValueError:
            continue
        title = html.unescape(title)
        # The search also returns round-ups about peers; keep what names this one.
        first = (company or "").split(" ")[0]
        if re.search(rf"\b{re.escape(ticker)}\b", title) or (len(first) > 2 and first.lower() in title.lower()):
            out.append((stamp, title))
    return sorted(out, reverse=True)[:4]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    news = "--no-news" not in sys.argv
    tickers = [a.upper() for a in args]
    if not tickers:
        sys.exit(__doc__)

    found = earnings(tickers)
    today = dt.date.today()
    print(f"## Earnings in the next {AHEAD_DAYS} days (Nasdaq calendar, read {today})")
    print("Ticker|Date|Days away|When|Consensus EPS")
    print("---|---|---|---|---")
    for t in sorted(found, key=lambda t: found[t][0]):
        day, when, eps = found[t]
        print(f"{t}|{day:%a %Y-%m-%d}|{(day - today).days}|{when}|{eps}")
    quiet = [t for t in tickers if t not in found]
    if quiet:
        print(f"\nNo date in the window: {', '.join(quiet)}. ETFs never have one; for a company it means "
              "more than three weeks away or not yet scheduled.")

    if not news:
        return
    known = names()
    print("\n## Headlines, last three days (Google News; pointers, not reports)")
    for t in tickers:
        try:
            items = headlines(t, known.get(t))
        except Exception as e:
            print(f"- **{t}**: unavailable ({e})")
            continue
        if not items:
            print(f"- **{t}**: none")
        for stamp, title in items:
            print(f"- **{t}** {stamp:%d-%m %H:%M} UTC: {title}")
        time.sleep(0.3)


if __name__ == "__main__":
    main()
