"""Structural levels for the stop: the Fibonacci and DeMark supports under a price.

The playbook's STOP HIERARCHY builds a stop from a LEVEL first (Fibonacci and
DeMark), then gives it room with the ATR, then caps it with the loss floor and
sizes the order on it. This module is the arithmetic of the first step, kept in
one place so `chart-read.py` (today's reading) and any replay on past bars use
the same code. It reads bars; it does not fetch them.

A bar is `(date, high, low, close)`, oldest first.

The Fibonacci anchors are a default, not a verdict: the fibonacci-charts skill
says the anchors are the whole question, so two legs are printed (the lowest
weekly pivot low of the 52 weeks, and of the 26 weeks, before the highest
weekly pivot high of the last year) and the reader keeps the one the chart
supports.
"""
import datetime as dt

FIB_RATIOS = (0.236, 0.382, 0.5, 0.618, 0.786)
#: A level this close to a neighbour (in ATRs) is one zone with it.
ZONE_GAP_ATR = 0.5
#: The most a zone may span (in ATRs) however long the chain of neighbours.
ZONE_SPAN_ATR = 1.0
#: The stop sits this far under the zone (the playbook's ROOM FOR THE NOISE).
BUFFER_ATR = 1.0
#: The loss cap: no stop under this share of the entry.
FLOOR = 0.90


def by_week(rows):
    """One bar per week, labelled by its Monday, from daily or weekly bars."""
    out = {}
    for day, h, l, c in rows:
        monday = day - dt.timedelta(days=day.weekday())
        if monday in out:
            _, h0, l0, _ = out[monday]
            out[monday] = (monday, max(h, h0), min(l, l0), c)
        else:
            out[monday] = (monday, h, l, c)
    return [out[k] for k in sorted(out)]


def weekly_pivots(w):
    """Swing pivots of weekly bars: the extreme of the three weeks either side.
    Returns [(index, 'H'|'L', price, monday)]; the last ones are unconfirmed."""
    highs, lows, out = [r[1] for r in w], [r[2] for r in w], []
    for i in range(3, len(w)):
        a, b = i - 3, min(len(w), i + 4)
        if highs[i] == max(highs[a:b]):
            out.append((i, "H", highs[i], w[i][0]))
        if lows[i] == min(lows[a:b]):
            out.append((i, "L", lows[i], w[i][0]))
    return out


def atr14(rows):
    tr = [max(rows[j][1], rows[j - 1][3]) - min(rows[j][2], rows[j - 1][3]) for j in range(len(rows) - 14, len(rows))]
    return sum(tr) / 14


def td_sequential(rows):
    """TD Sequential on (date, high, low, close) bars, by the rules in
    .claude/skills/demark-charts/references/demark-rules.md: a setup is nine
    consecutive closes beyond the close four bars earlier, started by a price
    flip; the countdown runs from bar nine, counts closes beyond the extreme
    two bars earlier, completes on the 13-vs-8 rule and is cancelled by an
    opposite setup or by a true extreme beyond TDST. A new setup in the same
    direction restarts the countdown (the recycle qualifiers are not applied).
    Returns (running, setups, countdown): the count in progress, every
    completed setup, and the countdown of the newest one."""
    n = len(rows)
    H, L, C = [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows]
    th = [max(H[i], C[i - 1]) if i else H[i] for i in range(n)]  # true high and low
    tl = [min(L[i], C[i - 1]) if i else L[i] for i in range(n)]
    side, count, start, setups = None, 0, 0, []
    for i in range(5, n):
        now = "buy" if C[i] < C[i - 4] else "sell" if C[i] > C[i - 4] else None
        if now is None or now != side:
            side, count, start = now, (1 if now else 0), i  # a price flip starts the other count
        else:
            count += 1
        if now and count == 9:
            bars9 = range(start, i + 1)
            if now == "buy":
                worst = min(bars9, key=lambda j: tl[j])
                setups.append({"side": "buy", "at": i, "tdst": max(th[j] for j in bars9),
                               "risk": tl[worst] - (th[worst] - tl[worst])})
            else:
                worst = max(bars9, key=lambda j: th[j])
                setups.append({"side": "sell", "at": i, "tdst": min(tl[j] for j in bars9),
                               "risk": th[worst] + (th[worst] - tl[worst])})
    for s in setups:  # perfection: bar 8, 9 or a later bar reaches the extreme of bars 6 and 7
        i = s["at"]
        if s["side"] == "buy":
            level = min(L[i - 3], L[i - 2])
            s["perfected"] = next((j for j in range(i - 1, n) if L[j] <= level), None)
        else:
            level = max(H[i - 3], H[i - 2])
            s["perfected"] = next((j for j in range(i - 1, n) if H[j] >= level), None)
    cd = None
    if setups:
        s = setups[-1]
        cd = {"count": 0, "done": None, "cancelled": None, "deferred": False}
        eighth = None
        for i in range(s["at"], n):
            later = [x for x in setups if x["at"] == i and x is not s]
            if any(x["side"] != s["side"] for x in later):
                cd["cancelled"] = "an opposite setup completed"
                break
            if s["side"] == "buy" and tl[i] > s["tdst"] or s["side"] == "sell" and th[i] < s["tdst"]:
                cd["cancelled"] = "price moved beyond TDST"
                break
            hit = C[i] <= L[i - 2] if s["side"] == "buy" else C[i] >= H[i - 2]
            if not hit:
                continue
            if cd["count"] < 12:
                cd["count"] += 1
                if cd["count"] == 8:
                    eighth = C[i]
            elif (L[i] <= eighth) if s["side"] == "buy" else (H[i] >= eighth):
                cd["count"], cd["done"] = 13, i
                break
            else:
                cd["deferred"] = True  # a "+": the 13 waits for the 13-vs-8 rule
    return (side, count), setups, cd


def fib_legs(weeks):
    """The default Fibonacci legs: [(label, low, high)] — see the module docstring."""
    piv = weekly_pivots(weeks)
    if not piv:
        return []
    last = weeks[-1][0]
    top = max((p for p in piv if p[1] == "H" and (last - p[3]).days <= 364), key=lambda p: p[2], default=None)
    if top is None:
        return []
    legs = []
    for span, name in ((52, "major"), (26, "recent")):
        lows = [p for p in piv if p[1] == "L" and p[0] < top[0] and top[0] - p[0] <= span]
        if not lows:
            continue
        low = min(lows, key=lambda p: p[2])
        if top[2] > low[2] and not any(abs(low[2] - x[2]) < 1e-9 for _, x, _ in legs):
            legs.append((name, low, top))
    return [(f"{name} leg {lo[3]:%y-%m-%d} L {lo[2]:.2f} → {hi[3]:%y-%m-%d} H {hi[2]:.2f}", lo[2], hi[2]) for name, lo, hi in legs]


def supports(rows, close=None):
    """Every Fibonacci and DeMark support under `close` (default: the last close).
    Returns [{'price', 'kind', 'label'}], nearest first."""
    close = rows[-1][3] if close is None else close
    out = []
    weeks = by_week(rows)
    for label, lo, hi in fib_legs(weeks):
        for r in FIB_RATIOS:
            p = hi - r * (hi - lo)
            if p < close:
                out.append({"price": p, "kind": "fib", "label": f"Fib {r} of {label}"})
        if lo < close:
            out.append({"price": lo, "kind": "fib", "label": f"Fib 1.0 (the leg's low) of {label}"})
    for frame, bars, keep in (("daily", rows, 90), ("weekly", weeks, 26)):
        if len(bars) < 20:
            continue
        _, setups, _ = td_sequential(bars)
        recent = [s for s in setups if len(bars) - 1 - s["at"] <= keep]
        for side in ("buy", "sell"):
            mine = [s for s in recent if s["side"] == side]
            if not mine:
                continue
            s = mine[-1]
            when = f"{bars[s['at']][0]:%d-%m}"
            if side == "buy":
                if s["risk"] < close:
                    out.append({"price": s["risk"], "kind": "demark",
                                "label": f"DeMark {frame} buy-setup risk level (9 on {when})"})
                if s["tdst"] < close:
                    out.append({"price": s["tdst"], "kind": "demark",
                                "label": f"DeMark {frame} TDST (buy setup 9 on {when}; price is above it)"})
            elif s["tdst"] < close:
                out.append({"price": s["tdst"], "kind": "demark",
                            "label": f"DeMark {frame} TDST support (sell setup 9 on {when})"})
    out.sort(key=lambda x: -x["price"])
    return out


def averages(rows):
    c = [r[3] for r in rows]
    return {n: sum(c[-n:]) / n for n in (21, 50, 55, 144, 200) if len(c) >= n}


def stop_for(rows, entry=None):
    """The STOP HIERARCHY on these bars: the zone of structural levels the entry
    holds above, one ATR under it, against the loss floor. `entry` defaults to
    the last close. Returns a dict, or None when no level lies under the entry."""
    entry = rows[-1][3] if entry is None else entry
    atr = atr14(rows)
    sup = supports(rows, entry)
    if not sup:
        return None
    zone = [sup[0]]
    for s in sup[1:]:
        if zone[-1]["price"] - s["price"] <= ZONE_GAP_ATR * atr and zone[0]["price"] - s["price"] <= ZONE_SPAN_ATR * atr:
            zone.append(s)
        else:
            break
    lo = zone[-1]["price"]
    structural = lo - BUFFER_ATR * atr
    floor = FLOOR * entry
    avgs = averages(rows)
    near = [f"SMA{n} {v:.2f}" for n, v in avgs.items() if any(abs(v - z["price"]) <= 0.5 * atr for z in zone)]
    return {
        "entry": entry, "atr": atr, "zone": zone, "zone_hi": zone[0]["price"], "zone_lo": lo,
        "structural": structural, "floor": floor, "cap_bound": structural < floor,
        "stop": max(structural, floor), "confluence": near, "ladder": sup,
    }
