#!/usr/bin/env python3
"""Raw material for a chart read when the corpus has no chart of a ticker.

  python3 scripts/chart-read.py BE STX GEV

Prints, per ticker, from two years of Yahoo bars: the 21/55/144/200-day
averages with their direction, rate-of-change momentum on three horizons, the
14-day average true range, the weekly swing pivots, the last ten weekly bars
(each dated by its Monday) and the TD Sequential counts on daily and weekly
bars (setup 9, countdown 13, TDST and risk level, by the rules in the
demark-charts skill). It does not interpret anything: the trend, the anchors,
the Fibonacci levels and what a count means are read off this output with the
technical-analysis, fibonacci-charts and demark-charts skills.
"""
import datetime as dt
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import levels  # noqa: E402  (the Fibonacci, DeMark and stop arithmetic, shared with the replays)

# A US listing of a foreign stock that is too young for a 200-day average is
# read on the original share as well. Keep in step with scripts/marketdata.py.
UNDERLYING = {"SKHY": "000660.KS"}  # SK hynix, Korea Exchange

URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=2y&interval={}"


def bars(ticker, interval):
    req = urllib.request.Request(URL.format(ticker, interval), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as res:
        r = json.load(res)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    closes = list(q["close"])
    # After the close Yahoo sometimes returns the newest bar with its high and
    # low but no close; the close is then in the quote's regular-market price.
    last = r["meta"].get("regularMarketPrice")
    if closes and closes[-1] is None and q["high"][-1] is not None and last:
        closes[-1] = last
    return [
        (dt.date.fromtimestamp(t), h, l, c)
        for t, h, l, c in zip(r["timestamp"], q["high"], q["low"], closes)
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


def td_line(label, rows):
    (side, count), setups, cd = levels.td_sequential(rows)
    day = lambda i: f"{rows[i][0]:%d-%m-%y}"  # noqa: E731
    ago = lambda i: len(rows) - 1 - i  # noqa: E731
    out = [f"running {side} setup {count}" if side else "no setup running"]
    if setups:
        s = setups[-1]
        where = "resistance" if s["side"] == "buy" else "support"
        perfect = "perfected" if s["perfected"] is not None else "NOT perfected"
        out.append(
            f"last completed: {s['side'].upper()} setup 9 on {day(s['at'])} ({ago(s['at'])} bars ago, {perfect}) · "
            f"TDST {where} {s['tdst']:.2f} · risk level {s['risk']:.2f}"
        )
        if cd["done"] is not None:
            out.append(f"{s['side']} countdown 13 completed {day(cd['done'])} ({ago(cd['done'])} bars ago)")
        elif cd["cancelled"]:
            out.append(f"its countdown was cancelled at {cd['count']} ({cd['cancelled']})")
        else:
            out.append(f"{s['side']} countdown at {cd['count']}{'+ (13 deferred)' if cd['deferred'] else ''} of 13")
    else:
        out.append("no completed setup in the window")
    print(f"  DeMark {label}: " + " · ".join(out))


def stop_ladder(d):
    """The STOP LADDER: the Fibonacci and DeMark supports under the close and the stop the
    playbook's STOP HIERARCHY builds from them (level first, ATR second, the loss floor third)."""
    r = levels.stop_for(d)
    close = d[-1][3]
    if r is None:
        print("  STOP LADDER: no Fibonacci or DeMark support under the close")
        return
    a = r["atr"]
    print(f"  STOP LADDER (supports under {close:.2f}; anchors are a default, keep the leg the chart supports):")
    for s in r["ladder"][:9]:
        print(f"    {s['price']:9.2f}  {100 * (s['price'] / close - 1):+6.1f}%  {(close - s['price']) / a:4.1f} ATR  {s['label']}")
    z = r["zone"]
    print(
        f"  STOP HIERARCHY: zone {r['zone_lo']:.2f}–{r['zone_hi']:.2f} ({len(z)} level{'s' if len(z) > 1 else ''}"
        f"{', confluence ' + ' · '.join(r['confluence']) if r['confluence'] else ''}) "
        f"− 1 ATR {a:.2f} = {r['structural']:.2f} ({100 * (r['structural'] / close - 1):+.1f}%) · "
        f"loss floor {r['floor']:.2f} → "
        + (f"CAP-BOUND: rests at {r['floor']:.2f}; the chart exit is a daily close under {r['zone_lo']:.2f}"
           + ("" if close - r["zone_lo"] >= a else " (NOT used: under 1 ATR from the close, too tight)")
           if r["cap_bound"] else f"LEVEL-BOUND: rests at {r['structural']:.2f}")
    )


def read(ticker):
    d, w = bars(ticker, "1d"), by_week(bars(ticker, "1wk"))
    c = [r[3] for r in d]
    print(f"\n=== {ticker} · last bar {d[-1][0]} · {c[-1]:.2f}")
    if len(c) >= 220:  # the playbook's OWN TREND gate, on its own definitions
        m50, m200, was = sma(c, 50), sma(c, 200), sma(c, 200, len(c) - 20)
        ok = c[-1] > m50 and m200 > was
        print(
            f"  OWN TREND {'passes' if ok else 'FAILS'}: close {c[-1]:.2f} "
            f"{'above' if c[-1] > m50 else 'not above'} SMA50 {m50:.2f} · "
            f"SMA200 {m200:.2f} {'rising' if m200 > was else 'not rising'} {100 * (m200 / was - 1):+.2f}% in 20d"
        )
    elif ticker in UNDERLYING and len(c) >= 50:
        # Its own 50-day (the price that is bought), the original's 200-day slope.
        u = [r[3] for r in bars(UNDERLYING[ticker], "1d")]
        m50 = sma(c, 50)
        if len(u) >= 220:
            m200, was = sma(u, 200), sma(u, 200, len(u) - 20)
            ok = c[-1] > m50 and m200 > was
            print(
                f"  OWN TREND {'passes' if ok else 'FAILS'}: close {c[-1]:.2f} "
                f"{'above' if c[-1] > m50 else 'not above'} SMA50 {m50:.2f} · "
                f"{len(c)} sessions of its own, so the 200-day is {UNDERLYING[ticker]}'s: "
                f"{m200:,.0f} {'rising' if m200 > was else 'not rising'} {100 * (m200 / was - 1):+.2f}% in 20d"
            )
        else:
            print("  OWN TREND FAILS: under 220 sessions of history here and on the original share")
    else:
        print("  OWN TREND FAILS: under 220 sessions of history, no 200-day slope")
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
    # The room a stop needs (the playbook's ROOM FOR THE NOISE): 14-day average true range.
    tr = [max(d[j][1], d[j - 1][3]) - min(d[j][2], d[j - 1][3]) for j in range(len(d) - 14, len(d))]
    atr = sum(tr) / 14
    print(f"  ATR14 {atr:.2f} ({100 * atr / c[-1]:.1f}% of the close) · close − 2 ATR {c[-1] - 2 * atr:.2f}")
    # TD Sequential. A BUY setup or countdown counts weakness: its 9 or 13 is
    # bullish (selling exhausting); a SELL 9 or 13 is bearish.
    td_line("daily", d)
    td_line("weekly", [r for r in w if r[0] < this_week or dt.date.today().weekday() >= 5] or w)
    stop_ladder(d)
    top = max(d, key=lambda r: r[1])
    print(f"  2y high {top[1]:.2f} on {top[0]} · low since {min(r[2] for r in d if r[0] >= top[0]):.2f}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for t in sys.argv[1:]:
        try:
            read(t.upper())
            if t.upper() in UNDERLYING:  # the long history: averages, pivots, Fibonacci anchors, counts
                print(f"\n  ↳ {t.upper()} is a US listing of {UNDERLYING[t.upper()]}: its long history, in the original's currency")
                read(UNDERLYING[t.upper()])
        except Exception as e:  # one bad ticker must not lose the others
            print(f"\n=== {t.upper()} · no data ({e})")
