#!/usr/bin/env python3
"""Raw material for a chart read when the corpus has no chart of a ticker.

  python3 scripts/chart-read.py BE STX GEV

Prints, per ticker, from two years of Yahoo bars: the 21/55/144/200-day
averages with their direction, rate-of-change momentum on three horizons, the
weekly swing pivots and the last ten weekly bars (each dated by its Monday). It does not interpret
anything: the trend, the anchors and the Fibonacci levels are read off this
output with the technical-analysis and fibonacci-charts skills.
"""
import datetime as dt
import json
import sys
import urllib.request

URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=2y&interval={}"


def bars(ticker, interval):
    req = urllib.request.Request(URL.format(ticker, interval), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as res:
        r = json.load(res)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    return [
        (dt.date.fromtimestamp(t), h, l, c)
        for t, h, l, c in zip(r["timestamp"], q["high"], q["low"], q["close"])
        if c is not None and h is not None and l is not None
    ]


def by_week(rows):
    """One bar per week. Yahoo returns the running week twice: the bar that
    started on Monday and a second one stamped with the last trade."""
    out = {}
    for day, h, l, c in rows:
        monday = day - dt.timedelta(days=day.weekday())
        if monday in out:
            _, h0, l0, _ = out[monday]
            out[monday] = (monday, max(h, h0), min(l, l0), c)
        else:
            out[monday] = (monday, h, l, c)
    return [out[k] for k in sorted(out)]


def sma(closes, n, end=None):
    end = len(closes) if end is None else end
    return sum(closes[end - n:end]) / n


def read(ticker):
    d, w = bars(ticker, "1d"), by_week(bars(ticker, "1wk"))
    c = [r[3] for r in d]
    print(f"\n=== {ticker} · last bar {d[-1][0]} · {c[-1]:.2f}")
    for n in (21, 55, 144, 200):
        if len(c) < n + 10:
            print(f"  SMA{n}: not enough history")
            continue
        now, prev = sma(c, n), sma(c, n, len(c) - 10)
        print(
            f"  SMA{n} {now:.2f} · {'rising' if now > prev else 'falling'} "
            f"{100 * (now / prev - 1):+.2f}% in 10d · price "
            f"{'above' if c[-1] > now else 'below'} by {100 * (c[-1] / now - 1):+.1f}%"
        )
    for n, label in ((10, "10d"), (50, "50d"), (130, "130d")):
        if len(c) > n + 11:
            print(
                f"  ROC {label} {100 * (c[-1] / c[-1 - n] - 1):+.1f}% "
                f"(10d ago {100 * (c[-11] / c[-11 - n] - 1):+.1f}%)"
            )
    # A weekly pivot is the extreme of the three weeks either side of it.
    highs, lows, pivots = [r[1] for r in w], [r[2] for r in w], []
    for i in range(3, len(w)):
        a, b = i - 3, min(len(w), i + 4)
        if highs[i] == max(highs[a:b]):
            pivots.append(f"{w[i][0] - dt.timedelta(days=w[i][0].weekday()):%y-%m-%d} H {highs[i]:.2f}")
        if lows[i] == min(lows[a:b]):
            pivots.append(f"{w[i][0] - dt.timedelta(days=w[i][0].weekday()):%y-%m-%d} L {lows[i]:.2f}")
    print("  weekly pivots (the last ones are unconfirmed): " + " · ".join(pivots[-14:]))
    # Yahoo stamps the running week with the time of its last trade, not with
    # its Monday, so it read as a week of its own dated today. Every bar is
    # labelled by the Monday it belongs to, and the running one says so.
    monday = lambda day: day - dt.timedelta(days=day.weekday())  # noqa: E731
    this_week = monday(dt.date.today())
    weeks = [
        f"{monday(r[0]):%m-%d}{' (in progress)' if monday(r[0]) == this_week and dt.date.today().weekday() < 5 else ''} "
        f"{r[1]:.2f}/{r[2]:.2f}/{r[3]:.2f}"
        for r in w[-10:]
    ]
    print("  last 10 weeks, by their Monday, H/L/C: " + " | ".join(weeks))
    top = max(d, key=lambda r: r[1])
    print(f"  2y high {top[1]:.2f} on {top[0]} · low since {min(r[2] for r in d if r[0] >= top[0]):.2f}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for t in sys.argv[1:]:
        try:
            read(t.upper())
        except Exception as e:  # one bad ticker must not lose the others
            print(f"\n=== {t.upper()} · no data ({e})")
