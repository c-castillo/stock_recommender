"""Shared helpers for the report scripts: Yahoo daily closes with a day cache.

Yahoo answers "Too Many Requests" after a burst of about a hundred calls, and
the scorecard prices every ticker the reports ever named. So requests go one
at a time with a pause, and each day's bars are kept in `.whatsapp/cache/` so
a second run on the same day costs nothing.
"""
import datetime as dt
import glob
import json
import os
import time
import urllib.request
import zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, ".whatsapp", "reports")
CACHE = os.path.join(ROOT, ".whatsapp", "cache")
# The broker's commission per side and the yearly interest it pays on cash.
# Keep in step with lib/market/costs.ts.
COMMISSION_PC = 0.003
CASH_APR = 0.035
RISK_PER_POSITION = 0.0075
BASE = os.environ.get("DASHBOARD_URL", "http://localhost:3000")
HEDGES = {"SSG", "SOXS", "PSQ", "QID", "SQQQ", "SH", "SDS", "BITI", "SEF", "ERY"}
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
        # Bars fetched before 16:00 New York lack that day's close, so the cache
        # of the morning is not reused in the evening.
        now = ny_now()
        tag = "close" if phase(now) in ("after the close", "weekend") else "early"
        self.path = os.path.join(CACHE, f"closes-{now.date()}-{tag}-{rng}.json")
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
                # Yahoo sometimes leaves the newest daily bar empty for hours
                # after the close while the quote beside it has the price.
                m = r.get("meta") or {}
                if m.get("regularMarketTime") and m.get("regularMarketPrice") is not None:
                    day = dt.datetime.fromtimestamp(m["regularMarketTime"], zoneinfo.ZoneInfo("America/New_York"))
                    bars.setdefault(day.date().isoformat(), m["regularMarketPrice"])
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


def api(path, body=None, method=None, timeout=60):
    """One call to the dashboard. `body` makes it a JSON POST."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def ny_now():
    return dt.datetime.now(zoneinfo.ZoneInfo("America/New_York"))


def phase(now=None):
    """Where New York's clock stands. Holidays are not known here: a holiday
    reads as a trading day, and the last bar of SPY says which session closed."""
    now = now or ny_now()
    minutes = now.hour * 60 + now.minute
    if now.weekday() >= 5:
        return "weekend"
    if minutes < 570:
        return "pre-market"
    if minutes < 960:
        return "open"
    return "after the close"


def last_session(bars, now=None):
    """Date of the last session that has closed, from a ticker's daily bars.
    While the market is open today's bar is still moving, so it does not count."""
    now = now or ny_now()
    today = now.date().isoformat()
    done = [d for d in sorted(bars) if d < today or (d == today and phase(now) == "after the close")]
    return done[-1] if done else None


def report_files(suffix=".json"):
    """Report files of one kind, oldest first: `.json` is the recommendations
    (not the `.portfolio.json`, `.orders.json` or `.run.json` beside them)."""
    out = []
    for f in sorted(glob.glob(os.path.join(REPORTS, "*" + suffix))):
        name = os.path.basename(f)
        if name[10:] == suffix and len(name) == 10 + len(suffix):
            out.append(f)
    return out


def load(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default
