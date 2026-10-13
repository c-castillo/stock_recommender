"""Shared helpers for the report scripts: Yahoo daily closes with a day cache.

Yahoo answers "Too Many Requests" after a burst of about a hundred calls, and
the scorecard prices every ticker the reports ever named. So requests go one
at a time with a pause, and each day's bars are kept in `.whatsapp/cache/` so
a second run on the same day costs nothing.
"""
import datetime as dt
import json
import os
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, ".whatsapp", "reports")
CACHE = os.path.join(ROOT, ".whatsapp", "cache")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"


def get(url, timeout=20, accept="application/json", agent=UA):
    # Yahoo refuses the full browser string with a 429 and accepts the short one;
    # Nasdaq is the other way round.
    req = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", "replace")


class Closes:
    """Daily closes per ticker as {iso date: close}, oldest first."""

    def __init__(self, rng="6mo"):
        self.rng = rng
        os.makedirs(CACHE, exist_ok=True)
        self.path = os.path.join(CACHE, f"closes-{dt.date.today()}-{rng}.json")
        try:
            self.data = json.load(open(self.path))
        except (OSError, ValueError):
            self.data = {}
        self.failed = []
        self.limited = 0
        self.blocked = False

    def of(self, ticker):
        if ticker in self.data:
            return self.data[ticker]
        if self.blocked:
            self.failed.append(ticker)
            return {}
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={self.rng}&interval=1d"
        bars, limited = {}, False
        for attempt in range(2):
            try:
                r = json.loads(get(url, agent="Mozilla/5.0"))["chart"]["result"][0]
                closes = r["indicators"]["quote"][0]["close"]
                bars = {
                    dt.datetime.fromtimestamp(t, dt.timezone.utc).date().isoformat(): c
                    for t, c in zip(r["timestamp"], closes)
                    if c is not None
                }
                limited = False
                break
            except Exception as e:  # a 429 clears after a pause; anything else will not
                limited = "429" in str(e)
                if not limited:
                    break
                time.sleep(5)
        time.sleep(0.25)
        if bars:
            self.data[ticker] = bars
            self.limited = 0
            if len(self.data) % 15 == 0:  # an interrupted run keeps what it fetched
                self.save()
        else:
            self.failed.append(ticker)
            # Three tickers in a row refused: Yahoo has shut the door for now.
            # Stop asking instead of sleeping through a hundred more.
            self.limited = self.limited + 1 if limited else 0
            self.blocked = self.limited >= 3
        return bars

    def save(self):
        json.dump(self.data, open(self.path, "w"))


def close_on(bars, date):
    """Close on `date`, or the last one before it (a weekend report prices Friday)."""
    days = [d for d in bars if d <= date]
    return bars[days[-1]] if days else None


def last(bars):
    return bars[max(bars)] if bars else None
