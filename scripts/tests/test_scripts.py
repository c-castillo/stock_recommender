"""The report scripts' own logic: matching orders to the broker, the publish
checks, the calendar rules. Run with `pnpm test`. No network."""
import datetime as dt
import importlib.util
import os
import sys
import tempfile
import unittest
import zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)

import marketdata  # noqa: E402
import orders  # noqa: E402
import preflight  # noqa: E402


def load(name):
    """Import a script whose file name has a hyphen."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(SCRIPTS, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


publish = load("publish-check")
stop_check = load("stop-check")
NY = zoneinfo.ZoneInfo("America/New_York")


def broker(**o):
    base = {"id": "x", "ticker": "MU", "side": "sell", "type": "limit", "qty": 2, "limitPrice": 953.19, "stopPrice": None,
            "trailPercent": None, "filledQty": 0, "filledAvgPrice": None, "state": "open", "status": "Pendiente",
            "createdAt": "2026-10-13T20:43:23Z"}
    return {**base, **o}


def asked(**o):
    base = {"ticker": "MU", "side": "sell", "type": "limit", "qty": 2, "limitPrice": 953.19, "source": "order",
            "stopTriggered": False, "waitsFor": None}
    return {**base, **o}


class Clock(unittest.TestCase):
    def test_phase(self):
        at = lambda d, h, m: dt.datetime(2026, 10, d, h, m, tzinfo=NY)  # noqa: E731
        self.assertEqual(marketdata.phase(at(13, 7, 30)), "pre-market")
        self.assertEqual(marketdata.phase(at(13, 9, 30)), "open")
        self.assertEqual(marketdata.phase(at(13, 15, 59)), "open")
        self.assertEqual(marketdata.phase(at(13, 16, 0)), "after the close")
        self.assertEqual(marketdata.phase(at(17, 12, 0)), "weekend")

    def test_last_session_ignores_a_bar_still_moving(self):
        bars = {"2026-10-12": 1, "2026-10-13": 2}
        at = lambda d, h: dt.datetime(2026, 10, d, h, 0, tzinfo=NY)  # noqa: E731
        self.assertEqual(marketdata.last_session(bars, at(13, 11)), "2026-10-12")
        self.assertEqual(marketdata.last_session(bars, at(13, 17)), "2026-10-13")
        self.assertEqual(marketdata.last_session(bars, at(14, 7)), "2026-10-13")
        self.assertIsNone(marketdata.last_session({}, at(14, 7)))

    def test_close_on_takes_the_last_close_before_a_weekend(self):
        bars = {"2026-10-08": 1.0, "2026-10-09": 2.0, "2026-10-12": 3.0}
        self.assertEqual(marketdata.close_on(bars, "2026-10-11"), 2.0)
        self.assertIsNone(marketdata.close_on(bars, "2026-10-01"))


class Depth(unittest.TestCase):
    def reports(self, *specs):
        d = tempfile.mkdtemp()
        out = []
        for date, level in specs:
            f = os.path.join(d, f"{date}.md")
            with open(f, "w") as out_file:
                out_file.write(f"# report\nDepth: {level}\n")
            out.append(f)
        return out

    def test_weekly_on_the_first_run_after_the_week_closes(self):
        friday = self.reports(("2026-10-15", "DAILY"), ("2026-10-16", "DAILY"))
        self.assertEqual(preflight.depth(False, friday, dt.date(2026, 10, 16)), "DAILY")  # Friday, before its session
        self.assertEqual(preflight.depth(False, friday, dt.date(2026, 10, 17)), "WEEKLY")  # Saturday
        self.assertEqual(preflight.depth(False, friday, dt.date(2026, 10, 19)), "WEEKLY")  # Monday, Saturday missed

    def test_one_weekly_per_week(self):
        done = self.reports(("2026-10-16", "DAILY"), ("2026-10-17", "WEEKLY"))
        self.assertEqual(preflight.depth(False, done, dt.date(2026, 10, 19)), "DAILY")
        self.assertEqual(preflight.depth(False, done, dt.date(2026, 10, 20)), "DAILY")

    def test_forced_stale_and_empty(self):
        old = self.reports(("2026-10-01", "WEEKLY"))
        self.assertEqual(preflight.depth(True, old, dt.date(2026, 10, 2)), "WEEKLY")
        self.assertEqual(preflight.depth(False, old, dt.date(2026, 10, 14)), "WEEKLY")
        self.assertEqual(preflight.depth(False, [], dt.date(2026, 10, 14)), "WEEKLY")


class BookDiff(unittest.TestCase):
    def test_diff(self):
        before = {"positions": [{"ticker": "MU", "shares": 5, "avg_cost": 931.72}, {"ticker": "WYFI", "shares": 50, "avg_cost": 16.0}],
                  "cash_balance": 5000.0}
        after = {"positions": [{"ticker": "MU", "shares": 3, "avg_cost": 940.0}, {"ticker": "EBAY", "shares": 5, "avg_cost": 114.5}],
                 "cash_balance": 6906.38}
        lines = preflight.diff_book(before, after)
        self.assertEqual(len(lines), 4)
        self.assertIn("EBAY: new position, 5 sh at $114.50", lines)
        self.assertIn("WYFI: closed (50 sh gone)", lines)
        self.assertTrue(any(line.startswith("MU: 5 → 3 sh") for line in lines))
        self.assertIn("cash $5,000.00 → $6,906.38 (+1,906.38)", lines)
        self.assertEqual(preflight.diff_book(before, before), [])


class OrderMatching(unittest.TestCase):
    def test_states(self):
        day = "2026-10-13"
        self.assertEqual(orders.status(asked(), [broker()], day)[0], "working")
        self.assertEqual(orders.status(asked(), [broker(state="filled", filledQty=2, filledAvgPrice=951.0)], day),
                         ("filled", "filled 2 at $951.00"))
        self.assertEqual(orders.status(asked(), [broker(state="expired")], day)[0], "expired")
        self.assertEqual(orders.status(asked(), [], day)[0], "not sent")
        # An order of another day, side or ticker is not this order.
        self.assertEqual(orders.status(asked(), [broker(createdAt="2026-10-09T15:00:00Z")], day)[0], "not sent")
        self.assertEqual(orders.status(asked(), [broker(side="buy")], day)[0], "not sent")
        self.assertEqual(orders.status(asked(), [broker(ticker="LRCX")], day)[0], "not sent")

    def test_a_stop_is_not_an_entry_and_an_older_identical_stop_counts(self):
        stop = asked(type="stop", qty=1, limitPrice=None, stopPrice=924.78, source="stop")
        self.assertEqual(orders.status(stop, [broker()], "2026-10-13")[0], "not sent")
        resting = broker(type="stop", qty=1, limitPrice=None, stopPrice=924.78, createdAt="2026-10-10T15:00:00Z")
        self.assertEqual(orders.status(stop, [resting], "2026-10-13"), ("resting", "resting at $924.78"))
        other = broker(type="stop", qty=1, limitPrice=None, stopPrice=900.0, createdAt="2026-10-10T15:00:00Z")
        self.assertEqual(orders.status(stop, [other], "2026-10-13")[0], "not sent")

    def test_the_order_that_got_furthest_tells_what_happened(self):
        sent = [broker(state="expired"), broker(state="filled", filledQty=2, filledAvgPrice=950.0, createdAt="2026-10-14T13:31:00Z")]
        self.assertEqual(orders.status(asked(), sent, "2026-10-13")[0], "filled")

    def test_waiting_and_next_step(self):
        book = [asked(ticker="LRCX", qty=6), asked(ticker="MRVL", side="buy", qty=6, waitsFor="SELL 6 LRCX")]
        self.assertEqual(orders.waits_on(book[1], book, ["working", "not sent"]), "working")
        self.assertIsNone(orders.waits_on(book[0], book, ["working", "not sent"]))
        self.assertEqual(orders.next_step(book[1], "not sent", "working", 270), "waits for SELL 6 LRCX (working)")
        self.assertEqual(orders.next_step(book[1], "not sent", "filled", 270), "free to send: re-price it")
        self.assertEqual(orders.next_step(asked(stopTriggered=True), "expired", None, 940), "still owed: the stop fired")
        self.assertEqual(orders.next_step(asked(source="stop"), "not sent", None, 940), "place it")
        self.assertEqual(orders.next_step(asked(), "filled", None, 940), "—")

    def test_cost_of_waiting(self):
        # A sale not made while the price fell $13.19 on 2 shares.
        self.assertAlmostEqual(orders.missed(asked(), "expired", 940.0), 26.38)
        self.assertAlmostEqual(orders.missed(asked(side="buy"), "expired", 960.0), 13.62)
        self.assertIsNone(orders.missed(asked(), "filled", 940.0))
        self.assertIsNone(orders.missed(asked(source="stop"), "not sent", 940.0))

    def test_open_orders_against_the_book(self):
        positions = [{"ticker": "MU", "shares": 3}, {"ticker": "GLW", "shares": 10}, {"ticker": "SSG", "shares": 260}]
        open_orders = [broker(qty=2), broker(type="stop", qty=3, stopPrice=924.78), broker(ticker="WYFI", type="stop", qty=50)]
        notes = orders.broker_checks(open_orders, positions)
        self.assertTrue(any(n.startswith("MU: open sells total 5 sh against 3 held") for n in notes))
        self.assertTrue(any(n.startswith("WYFI: a sell order rests for 50 sh but none are held") for n in notes))
        self.assertIn("no stop resting: GLW", notes)  # the hedge needs none


class PublishChecks(unittest.TestCase):
    def rec(self, **o):
        base = {"ticker": "MRVL", "action": "BUY", "confidence": 60, "entryPrice": "$268.73 (close 13-10)",
                "stopLoss": "$248 daily close", "reasoning": "BUY 6 sh ≈ $1,612 — a new position"}
        return {**base, **o}

    def test_shape(self):
        self.assertEqual(publish.check_shape([self.rec()]), [])
        self.assertEqual(publish.check_shape([]), ["no recommendations"])
        bad = publish.check_shape([self.rec(action="WATCH", confidence="high", reasoning="")])
        self.assertEqual(len(bad), 3)

    def test_prices_and_amounts(self):
        self.assertEqual(publish.check_prices([self.rec()], {}, {"MRVL": 270.1}), [])
        self.assertEqual(len(publish.check_prices([self.rec()], {}, {"MRVL": 290.0})), 1)
        # A SELL of something not held is an opinion, not an order: no price check.
        self.assertEqual(publish.check_prices([self.rec(action="SELL")], {}, {"MRVL": 290.0}), [])
        self.assertEqual(publish.check_amounts([self.rec()]), [])
        self.assertEqual(len(publish.check_amounts([self.rec(reasoning="BUY 6 sh ≈ $2,612 — wrong")])), 1)

    def test_book(self):
        sell = self.rec(ticker="LRCX", action="SELL", entryPrice="$301.11", reasoning="SELL 6 sh ≈ $1,807 — funding leg")
        held = {"LRCX": 14}
        self.assertEqual(publish.check_book([sell, self.rec()], held, 100.0), [])  # the sale funds the buy
        self.assertEqual(len(publish.check_book([self.rec(), self.rec(ticker="LRCX", action="HOLD", reasoning="HOLD")], held, 100.0)), 1)
        over = self.rec(ticker="LRCX", action="SELL", entryPrice="$301.11", reasoning="SELL 20 sh ≈ $6,022 — too many")
        self.assertTrue(any("SELL 20 sh but 14 are held" in b for b in publish.check_book([over], held, 0)))
        self.assertTrue(any(b.startswith("held with no row: LRCX") for b in publish.check_book([self.rec()], held, 5000)))

    def test_earnings(self):
        today = dt.date(2026, 10, 14)  # a Wednesday
        self.assertEqual(publish.sessions_until(dt.date(2026, 10, 19), today), 3)  # Thu, Fri, Mon
        bad, _ = publish.check_earnings([self.rec()], {}, {"MRVL": dt.date(2026, 10, 19)}, today)
        self.assertEqual(len(bad), 1)
        bad, notes = publish.check_earnings([self.rec()], {}, {"MRVL": dt.date(2026, 10, 27)}, today)
        self.assertEqual(bad, [])
        self.assertIn("9 sessions away", notes[0])
        bad, notes = publish.check_earnings([self.rec()], {"MRVL": 6}, {"MRVL": dt.date(2026, 10, 15)}, today)
        self.assertEqual(bad, [])  # adding to a held name is the analyst's call, flagged not failed
        bad, _ = publish.check_earnings([self.rec()], {}, None, today)
        self.assertEqual(len(bad), 1)  # a calendar that could not be read is not a pass
        self.assertEqual(publish.check_earnings([self.rec(action="HOLD", reasoning="HOLD")], {}, None, today), ([], []))

    def test_risk(self):
        book = 34769.24  # budget $260.77
        self.assertEqual(publish.check_risk([self.rec()], book), [])  # 6 × $20.73 = $124
        big = self.rec(reasoning="BUY 20 sh ≈ $5,375 — too large")  # 20 × $20.73 = $415
        self.assertTrue(any("12 sh" in b for b in publish.check_risk([big], book)))
        self.assertEqual(len(publish.check_risk([self.rec(stopLoss=None)], book)), 1)
        self.assertEqual(publish.check_risk([self.rec(ticker="SSG")], book), [])

    def test_orders_file(self):
        recs = [self.rec(ticker="LRCX", action="SELL", entryPrice="$301.11", reasoning="SELL 6 sh ≈ $1,807 — funding leg")]
        ok = [{"ticker": "LRCX", "side": "sell", "type": "limit", "qty": 6, "limitPrice": 299.6, "source": "order", "mustFill": True},
              {"ticker": "LRCX", "side": "sell", "type": "stop", "qty": 8, "stopPrice": 295.37, "source": "stop"}]
        self.assertEqual(publish.check_orders(recs, ok, {"LRCX": 14}, {"LRCX": 301.11}), [])
        at_market = [{**ok[0], "limitPrice": 301.11}]
        self.assertTrue(any("must fill" in b for b in publish.check_orders(recs, at_market, {"LRCX": 14}, {"LRCX": 301.11})))
        self.assertTrue(any("not in the orders file" in b for b in publish.check_orders(recs, [], {"LRCX": 14}, {})))
        wrong = [{**ok[0], "qty": 5}]
        self.assertTrue(any("6 sh, the orders file 5" in b for b in publish.check_orders(recs, wrong, {"LRCX": 14}, {})))
        extra = ok + [{"ticker": "MU", "side": "sell", "type": "limit", "qty": 1, "limitPrice": 950, "source": "order"}]
        self.assertTrue(any("MU is in the orders file" in b for b in publish.check_orders(recs, extra, {"LRCX": 14, "MU": 3}, {})))


class StopParser(unittest.TestCase):
    def test_the_first_dollar_figure_is_the_level(self):
        level = lambda s: float(stop_check.LEVEL.search(s).group(1).replace(",", ""))  # noqa: E731
        self.assertEqual(level("$310 weekly close (the main analyst's invalidation); disaster stop $300.70"), 310.0)
        self.assertEqual(level("$1,087.98 close of 07-10"), 1087.98)
        self.assertIsNone(stop_check.LEVEL.search("Exit: two consecutive SMH closes above 600"))


if __name__ == "__main__":
    unittest.main()
