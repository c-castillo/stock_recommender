#!/usr/bin/env python3
"""What became of the last report's orders, read from the broker.

  python3 scripts/orders.py              # the newest report before today
  python3 scripts/orders.py 2026-10-13   # that report's orders

Reads `.whatsapp/reports/<date>.orders.json` and the orders the last Zesty
sync stored (`/api/portfolio`), and prints one row per order: filled and at
what price, still working, expired, never sent, or waiting for another order.
Then what the open orders at the broker say against the book: a sale for more
shares than are held, a stop on a ticker that is gone, a long with no stop.

No model call and nothing is sent: it only reads. The next report decides what
to do with an order that did not fill; this says which ones those are and what
the wait has cost so far.
"""
import datetime as dt
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

from marketdata import COMMISSION_PC, HEDGES, REPORTS, api, load, report_files

WAITS = re.compile(r"(BUY|SELL)\s+([\d.]+)\s+([A-Z.]+)", re.I)
STOPS = ("stop", "stop_limit", "trailing_stop")
RANK = {"filled": 0, "partial": 1, "open": 2, "expired": 3, "canceled": 4, "rejected": 5, "other": 6}


def family(kind):
    return "stop" if kind in STOPS else "entry"


def level(o):
    """The price an order is set at, whichever field carries it."""
    return o.get("stopPrice") or o.get("limitPrice")


def find(order, broker, since):
    """The broker order that is this report order, or None.

    Same ticker, side and kind (a stop or an entry), sent after the report's
    run started (`since`: an ISO time in UTC, or a bare date when the run
    record is missing). A run written after the close must not claim that
    day's earlier fills as its own. A stop that already rested at the same level and size
    before the report counts too: the report asked for what was there.
    """
    same = [
        b for b in broker
        if b["ticker"] == order["ticker"] and b["side"] == order["side"] and family(b["type"]) == family(order["type"])
    ]
    sent = [b for b in same if b["createdAt"] >= since]
    if family(order["type"]) == "stop":
        want = level(order)
        sent += [
            b for b in same
            if b["state"] == "open" and b not in sent and want and b.get("stopPrice")
            and abs(b["stopPrice"] / want - 1) < 0.005 and b.get("qty") == order["qty"]
        ]
    if not sent:
        return None
    # The same order can have been sent twice (an expiry, then again): the one
    # that got furthest is the one that tells what happened.
    return sorted(sent, key=lambda b: (RANK.get(b["state"], 9), -abs(b.get("qty") or 0), b["createdAt"]))[0]


def status(order, broker, since):
    """(state, text) for one report order."""
    b = find(order, broker, since)
    if b is None:
        return "not sent", "not sent"
    state = b["state"]
    if state == "filled":
        px = b.get("filledAvgPrice")
        return state, f"filled {b['filledQty']:g} at ${px:,.2f}" if px else "filled"
    if state == "partial":
        return state, f"filled {b['filledQty']:g} of {b.get('qty') or 0:g} at ${b.get('filledAvgPrice') or 0:,.2f}"
    if state == "open":
        return ("resting" if family(b["type"]) == "stop" else "working"), (
            f"resting at ${level(b):,.2f}" if family(b["type"]) == "stop" and level(b) else f"working at ${level(b) or 0:,.2f}"
        )
    return state, f"{state} unfilled"


def waits_on(order, orders, states):
    """The state of the order this one waits for, or None when it waits for nothing."""
    m = WAITS.search(order.get("waitsFor") or "")
    if not m:
        return None
    side, qty, ticker = m.group(1).lower(), float(m.group(2)), m.group(3).upper()
    for i, o in enumerate(orders):
        if o["ticker"] == ticker and o["side"] == side and family(o["type"]) == "entry":
            return states[i]
    return "not found"


def next_step(order, state, waiting, price):
    """What the next report has to do with it, in a few words."""
    if state in ("filled", "resting", "working"):
        return "—"
    if state == "partial":
        return "decide the rest"
    if state == "not sent" and waiting and waiting not in ("filled",):
        return f"waits for {order['waitsFor']} ({waiting})"
    if order.get("source") == "stop":
        return "place it" if state == "not sent" else f"{state}: place it again"
    if order.get("stopTriggered"):
        return "still owed: the stop fired"
    if state == "not sent" and waiting == "filled":
        return "free to send: re-price it"
    return "re-decide at today's price"


def missed(order, state, price):
    """Dollars the unfilled order has cost (+) or saved (−) since the report."""
    ref = level(order)
    if state in ("filled", "resting", "working") or order.get("source") == "stop" or not ref or not price:
        return None
    gap = (ref - price) if order["side"] == "sell" else (price - ref)
    return gap * order["qty"] if abs(gap * order["qty"]) >= 1 else None


def broker_checks(open_orders, positions):
    held = {p["ticker"]: p["shares"] for p in positions}
    notes, sells = [], {}
    for o in open_orders:
        if o["side"] == "sell":
            sells[o["ticker"]] = sells.get(o["ticker"], 0) + (o.get("qty") or 0)
    for t, q in sorted(sells.items()):
        have = held.get(t, 0)
        if not have:
            notes.append(f"{t}: a sell order rests for {q:g} sh but none are held: cancel it")
        elif q > have + 1e-6:
            notes.append(f"{t}: open sells total {q:g} sh against {have:g} held: once one fills the other is for too many")
    stopped = {o["ticker"] for o in open_orders if o["side"] == "sell" and o["type"] in STOPS}
    bare = [t for t in held if t not in HEDGES and t not in stopped]
    if bare:
        notes.append("no stop resting: " + ", ".join(sorted(bare)))
    return notes


def written_at(date):
    """When the report's run started, in UTC ("2026-10-22T02:05:00Z"), from
    its run record; the bare date when there is none."""
    run = load(os.path.join(REPORTS, f"{date}.run.json"), {}) or {}
    try:
        ny = dt.datetime.strptime(run["startedNY"], "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo("America/New_York"))
        return ny.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (KeyError, ValueError):
        return date


def main():
    today = dt.date.today().isoformat()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        path = os.path.join(REPORTS, f"{args[0]}.orders.json")
    else:
        files = [f for f in report_files(".orders.json") if os.path.basename(f)[:10] < today] or report_files(".orders.json")
        path = files[-1] if files else None
    try:
        book = api("/api/portfolio")
    except Exception as e:
        sys.exit(f"dashboard not answering ({e}): start it with `pnpm dev`")
    broker = book.get("orders")
    positions = book.get("positions", [])
    if not broker:
        sys.exit("no broker orders stored: run the Zesty sync first")
    read = dt.datetime.fromtimestamp(broker["at"]).strftime("%d-%m %H:%M")
    everything = broker["open"] + broker["closed"]

    orders = (load(path, {}) or {}).get("orders", []) if path else []
    date = os.path.basename(path)[:10] if path else None
    print(f"## Orders of the last report ({date or 'none'}), against the broker as read {read}")
    if not orders:
        print("The last report asked for no orders.")
    else:
        tickers = sorted({o["ticker"] for o in orders})
        prices = api("/api/prices?tickers=" + ",".join(tickers)).get("prices", {})
        since = written_at(date)
        pairs = [status(o, everything, since) for o in orders]
        states = [s for s, _ in pairs]
        print("Order|Asked|At the broker|Price now|Cost of waiting|Next")
        print("---|---|---|---|---|---")
        owed = 0.0
        for o, (state, text) in zip(orders, pairs):
            px = prices.get(o["ticker"])
            waiting = waits_on(o, orders, states)
            ref = level(o)
            kind = "stop" if o.get("source") == "stop" else o["type"]
            asked = f"{kind} ${ref:,.2f}" if ref else f"{o.get('trailPercent')}% trail"
            cost = missed(o, state, px)
            owed += cost or 0
            if state == "filled":
                b = find(o, everything, date)
                fill = b.get("filledAvgPrice")
                if fill and ref and o.get("source") != "stop":
                    better = (fill - ref) if o["side"] == "sell" else (ref - fill)
                    text += f" ({better * b['filledQty']:+,.0f} $ vs asked, commission ${fill * b['filledQty'] * COMMISSION_PC:,.2f})"
            print(f"{o['side'].upper()} {o['qty']:g} {o['ticker']}|{asked}|{text}|"
                  f"{f'${px:,.2f}' if px else '—'}|{f'{cost:+,.0f} $' if cost is not None else '—'}|"
                  f"{next_step(o, state, waiting, px)}")
        if abs(owed) >= 1:
            print(f"\nOrders not filled have {'cost' if owed > 0 else 'saved'} ${abs(owed):,.0f} so far "
                  "(a sale not made while the price fell, a buy not made while it rose).")

    print("\n### Open at the broker")
    if not broker["open"]:
        print("Nothing.")
    else:
        print("Ticker|Side|Type|Shares|Level|Placed")
        print("---|---|---|---|---|---")
        for o in broker["open"]:
            lvl = (f"{o['trailPercent']:g}% trail, now ${o['stopPrice']:,.2f}" if o["type"] == "trailing_stop" and o.get("stopPrice")
                   else f"${level(o):,.2f}" if level(o) else "market")
            print(f"{o['ticker']}|{o['side']}|{o['type']}|{o.get('qty') or 0:g}|{lvl}|{o['createdAt'][:10]}")
    notes = broker_checks(broker["open"], positions)
    print("\n" + ("\n".join(f"- {n}" for n in notes) if notes else "Open orders agree with the book."))

    since = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    fills = [o for o in broker["closed"] if o["filledQty"] > 0 and o["createdAt"][:10] >= since]
    if fills:
        print("\n### Fills of the last 7 days")
        print("Sent|Order|Fill|Commission")
        print("---|---|---|---")
        for o in fills:
            amount = o["filledQty"] * (o.get("filledAvgPrice") or 0)
            print(f"{o['createdAt'][:10]}|{o['side'].upper()} {o['filledQty']:g} {o['ticker']} ({o['type']})|"
                  f"${o.get('filledAvgPrice') or 0:,.2f} = ${amount:,.2f}|${amount * COMMISSION_PC:,.2f}")


if __name__ == "__main__":
    main()
