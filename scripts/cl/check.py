#!/usr/bin/env python3
"""The checks a Chilean report must pass before it goes on the phone page.

  python3 scripts/cl/check.py TODAY

Reads `.whatsapp/cl/reports/TODAY.json` (recommendations) and
`TODAY.orders.json` against the stored Itaú book and Yahoo's prices:

- the shape of every row, and a row for every held ticker;
- each BUY's and held SELL's entry within 2% of the market;
- shares × price against the stated CLP on every order row;
- no sale for more shares than are held, and buys that fit in the cash-like
  balance (money-market fund + account cash) plus the session's sales;
- no BUY that loses more than the risk budget at its stop;
- the orders file agrees with the order rows, and a must-fill sale is
  priced under the last close.

Prints PASS or FAIL per check; exit code 1 on any FAIL.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from marketdata import ROOT, get  # noqa: E402

CL = os.path.join(ROOT, ".whatsapp", "cl")
REPORTS = os.path.join(CL, "reports")
HOLDINGS = os.path.join(CL, "holdings")
RISK = 0.0075
FIELDS = ("ticker", "company", "action", "confidence", "entryPrice", "priceTarget", "stopLoss",
          "role", "reasoning", "mentions", "sources")
SIZED = re.compile(r"^(BUY|SELL)\s+([\d.,]+)\s*sh\s*[=≈]\s*CLP\s*([\d.,]+)", re.I)


def clp(v):
    """'CLP 4.830' / '4.830,50' / 4830 → float; None when there is no number."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"\d[\d.,]*", str(v))
    if not m:
        return None
    s = m.group(0).rstrip(".,")
    if "," in s:
        return float(s.replace(".", "").replace(",", "."))
    if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        return float(s.replace(".", ""))
    return float(s)


def live(ticker):
    sym = ticker if re.search(r"[.^=]", ticker) else f"{ticker}.SN"
    try:
        r = json.loads(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d",
                           agent="Mozilla/5.0"))["chart"]["result"][0]
        return r["meta"]["regularMarketPrice"]
    except Exception:
        return None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: check.py YYYY-MM-DD")
    day = sys.argv[1]
    fails = []

    def check(name, problems):
        print(f"{'FAIL' if problems else 'PASS'}  {name}")
        for p in problems:
            print(f"      - {p}")
        fails.extend(problems)

    recs = json.load(open(os.path.join(REPORTS, f"{day}.json")))["recommendations"]
    orders_path = os.path.join(REPORTS, f"{day}.orders.json")
    orders = json.load(open(orders_path))["orders"] if os.path.exists(orders_path) else None
    statement = sorted(f for f in os.listdir(HOLDINGS) if len(f) == 15 and f.endswith(".json"))[-1]
    book = json.load(open(os.path.join(HOLDINGS, statement)))
    held = {p["ticker"]: p for p in book["positions"]}

    prices = {t: live(t) for t in sorted({r["ticker"] for r in recs} | set(held))}
    value = sum(p["shares"] * (prices.get(t) or p["statementPrice"]) for t, p in held.items())
    cash = sum(f["value"] for f in book["funds"]) + book["cash"] + book["pendingSettlement"]
    total = value + cash

    shape = []
    for r in recs:
        missing = [f for f in FIELDS if f not in r]
        if missing:
            shape.append(f"{r.get('ticker', '?')}: missing {', '.join(missing)}")
        if r.get("role") not in ("dividend", "growth", "bet"):
            shape.append(f"{r.get('ticker', '?')}: role {r.get('role')!r}")
        if r.get("action") not in ("BUY", "SELL", "HOLD"):
            shape.append(f"{r.get('ticker', '?')}: action {r.get('action')!r}")
        if not isinstance(r.get("confidence"), (int, float)) or not 0 <= r["confidence"] <= 100:
            shape.append(f"{r.get('ticker', '?')}: confidence {r.get('confidence')!r}")
    check("shape of every row", shape)
    check("a row for every held ticker", [f"{t} has no row" for t in held if t not in {r["ticker"] for r in recs}])

    near = []
    for r in recs:
        if r["action"] == "BUY" or (r["action"] == "SELL" and r["ticker"] in held):
            e, p = clp(r.get("entryPrice")), prices.get(r["ticker"])
            if e is None or p is None:
                near.append(f"{r['ticker']}: entry {r.get('entryPrice')!r}, market {p}")
            elif abs(e / p - 1) > 0.02:
                near.append(f"{r['ticker']}: entry {e:,.2f} is {100 * (e / p - 1):+.1f}% from the market {p:,.2f}")
    check("entries within 2% of the market", near)

    sized, arith = [], []
    for r in recs:
        m = SIZED.match(r.get("reasoning", ""))
        if not m:
            continue
        side, qty, amount = m.group(1).upper(), clp(m.group(2)), clp(m.group(3))
        price = clp(r.get("entryPrice")) or prices.get(r["ticker"])
        sized.append((r["ticker"], side, qty, price, r))
        if price and amount and abs(qty * price / amount - 1) > 0.02:
            arith.append(f"{r['ticker']}: {qty:g} × {price:,.2f} = {qty * price:,.0f}, row says CLP {amount:,.0f}")
    check("shares × price against the stated amount", arith)

    funds = []
    for t, side, qty, _, _ in sized:
        if side == "SELL" and qty > held.get(t, {}).get("shares", 0):
            funds.append(f"SELL {qty:g} {t}: only {held.get(t, {}).get('shares', 0):g} held")
    buys = sum(q * p for _, s, q, p, _ in sized if s == "BUY" and p)
    sells = sum(q * p for _, s, q, p, _ in sized if s == "SELL" and p)
    if buys > cash + sells * 0.99:
        funds.append(f"buys CLP {buys:,.0f} exceed cash-like CLP {cash:,.0f} + sales CLP {sells:,.0f}")
    check("sales within the shares held, buys within cash", funds)

    risk = []
    for t, side, qty, price, r in sized:
        stop = clp(r.get("stopLoss"))
        if side == "BUY":
            if not stop or not price or stop >= price:
                risk.append(f"BUY {t}: no usable stop ({r.get('stopLoss')!r})")
            elif qty * (price - stop) > total * RISK * 1.05:
                risk.append(f"BUY {t}: CLP {qty * (price - stop):,.0f} at risk, budget CLP {total * RISK:,.0f}")
    check("risk budget on every BUY", risk)

    agree = []
    if orders is None:
        agree.append(f"{os.path.basename(orders_path)} is missing")
    else:
        want = {(t, s.lower(), int(q)) for t, s, q, _, _ in sized}
        have = {(o["ticker"], o["side"], int(o.get("qty") or 0)) for o in orders if o.get("side") in ("buy", "sell")}
        for x in want - have:
            agree.append(f"order row {x[1].upper()} {x[2]} {x[0]} is not in the orders file")
        for x in have - want:
            agree.append(f"orders file has {x[1].upper()} {x[2]} {x[0]}, which is not an order row")
        for o in orders:
            if o.get("side") == "sell" and o.get("mustFill"):
                p = prices.get(o["ticker"])
                if p and o.get("limitPrice") and o["limitPrice"] > p:
                    agree.append(f"must-fill SELL {o['ticker']} at {o['limitPrice']} is above the last price {p}")
    check("orders file agrees with the report", agree)

    print(f"\nBook CLP {total:,.0f} (statement {statement[:10]}), cash-like CLP {cash:,.0f}.")
    print("RESULT: " + ("FAIL" if fails else "PASS"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
