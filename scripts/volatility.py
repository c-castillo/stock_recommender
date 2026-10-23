#!/usr/bin/env python3
"""How much room each stop has, and which stopped-out names have come back.

  python3 scripts/volatility.py

From Yahoo daily bars, per held long: the 14-day average true range (ATR, in $
and % of the close), the resting stop and its distance from the close in ATRs,
the LOSS DISCIPLINE floor (90% of the average cost) and the level two ATRs
under the close. Then every stop that filled in the last five sessions: where
it filled, the last close, whether price has closed back above the stop, and
the re-entry stop the playbook's WHIPSAW rule would use (the stop-out session's
low minus one ATR). The preflight appends it to TODAY.scorecard.md.

Why: 21 of 24 stop-outs from June to October closed back above the stop within
five sessions, yet 15 of the 24 were lower five sessions later. The stops had
sat inside one day's normal range (ATR 6-10% on most of these names).
"""
import datetime as dt
import importlib.util
import json
import os
import sys

from marketdata import HEDGES, ROOT, api, load

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("chart_read", os.path.join(HERE, "chart-read.py"))
chart_read = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chart_read)

MAX_LOSS = 0.10
RECENT_SESSIONS = 5


def atr(d, n=14, end=None):
    """Average true range of the n bars ending at index `end` (inclusive)."""
    end = len(d) - 1 if end is None else end
    tr = [max(d[j][1], d[j - 1][3]) - min(d[j][2], d[j - 1][3]) for j in range(end - n + 1, end + 1)]
    return sum(tr) / n


def stop_fills(orders):
    """(ticker, placed on, fill price, stop level) for every filled sell stop.
    The date is when the stop was PLACED: the broker gives no fill time (a
    leg's filledAt is when the sync saw it), so the fill session is found
    from the bars, as the first one from that day whose low reached the stop."""
    out = []
    for o in orders["closed"]:
        if o["type"] in ("stop", "trailing_stop") and o["side"] == "sell" and o["filledQty"] > 0:
            out.append((o["ticker"], o["createdAt"][:10], o.get("filledAvgPrice"), o.get("stopPrice")))
    # Bracket legs never show in the order lists: their fills live in the legs file.
    parents = {o["id"]: o for o in orders["closed"] + orders["open"]}
    for parent, legs in (load(os.path.join(ROOT, ".whatsapp", "zesty-legs.json"), {}) or {}).items():
        for leg in legs:
            if leg.get("filledQty") and parent in parents:
                p = parents[parent]
                out.append((p["ticker"], p["createdAt"][:10], leg.get("filledAvgPrice"), leg.get("stopPrice")))
    return out


def fill_session(d, placed, level):
    """Index of the first bar on or after `placed` whose low reached `level`."""
    start = dt.date.fromisoformat(placed)
    return next((i for i, r in enumerate(d) if r[0] >= start and r[2] <= level + 1e-9), None)


def main():
    book = api("/api/portfolio")
    orders = book.get("orders") or {"open": [], "closed": []}
    resting = {}
    for o in orders["open"]:
        if o["side"] == "sell" and o["type"] in ("stop", "trailing_stop") and o.get("stopPrice"):
            resting.setdefault(o["ticker"], []).append((o["qty"], o["stopPrice"]))
    since = (dt.date.today() - dt.timedelta(days=60)).isoformat()
    fills = [f for f in stop_fills(orders) if f[1] >= since]
    held = [p for p in book.get("positions", []) if p["shares"] > 0 and p["ticker"] not in HEDGES]
    bars = {}
    for t in sorted({p["ticker"] for p in held} | {f[0] for f in fills}):
        try:
            bars[t] = chart_read.bars(t, "1d")
        except Exception as e:
            print(f"  {t}: no bars ({e})", file=sys.stderr)

    last = max((d[-1][0] for d in bars.values()), default=None)
    print(f"\n## Volatility and stops (ATR 14 from Yahoo daily bars, last bar {last})")
    print("A stop closer than one ATR to the close sits inside a normal day's range. "
          "The playbook's ROOM FOR THE NOISE rule wants a new stop at least one ATR under the chart level "
          "and two ATRs under the entry, and never under the 90% floor.")
    print("\nTicker|Shares|Close|ATR|ATR %|Resting stop|Distance|In ATRs|90% floor|Close − 2 ATR|Flag")
    print("---|---|---|---|---|---|---|---|---|---|---")
    for p in held:
        t, d = p["ticker"], bars.get(p["ticker"])
        if not d or len(d) < 16:
            continue
        close, a = d[-1][3], atr(d)
        floor = p["avg_cost"] * (1 - MAX_LOSS) if p.get("avg_cost") else None
        stops = resting.get(t, [])
        top = max((s for _, s in stops), default=None)
        flag = "no stop rests" if top is None else ("inside 1 ATR: a normal day can take it" if close - top < a else "")
        print(f"{t}|{p['shares']:g}|${close:,.2f}|${a:,.2f}|{100 * a / close:.1f}%|"
              f"{', '.join(f'{q:g} at ${s:,.2f}' for q, s in stops) or '—'}|"
              f"{'—' if top is None else f'{100 * (top / close - 1):+.1f}%'}|"
              f"{'—' if top is None else f'{(close - top) / a:.1f}'}|"
              f"{'—' if floor is None else f'${floor:,.2f}'}|${close - 2 * a:,.2f}|{flag}")

    print(f"\n### Stopped out in the last {RECENT_SESSIONS} sessions (the WHIPSAW watch)")
    print("Ticker|Stopped|Fill|Stop|Last close|Closed back above the stop?|Sessions since|Low of that session|Re-entry stop (low − 1 ATR)")
    print("---|---|---|---|---|---|---|---|---")
    seen = set()
    rows = []
    for t, placed, fill, level in fills:
        d = bars.get(t)
        ref = level or fill
        idx = fill_session(d, placed, ref) if d and ref else None
        if idx is None or (t, idx) in seen or len(d) - 1 - idx > RECENT_SESSIONS:
            continue
        seen.add((t, idx))
        rows.append((d[idx][0], t, fill, ref, idx))
    if not rows:
        print("None.")
        return
    for day, t, fill, ref, idx in sorted(rows, reverse=True):
        d = bars[t]
        after = d[idx + 1:]
        back = next((r for r in after if r[3] > ref), None)
        a = atr(d, end=idx)
        low = d[idx][2]
        print(f"{t}|{day:%Y-%m-%d}|${fill:,.2f}|${ref:,.2f}|${d[-1][3]:,.2f}|"
              f"{f'yes, {back[0]:%d-%m} at ${back[3]:,.2f}' if back else 'no'}|{len(after)}|${low:,.2f}|${low - a:,.2f}")


if __name__ == "__main__":
    main()
