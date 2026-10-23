#!/usr/bin/env python3
"""Everything the daily run does before a model is needed, in one command.

  python3 scripts/preflight.py            # depth decided by the calendar
  python3 scripts/preflight.py weekly     # force the weekly review
  python3 scripts/preflight.py --no-sync  # reuse what is stored (a re-run)

In order: the MCP smoke test, the Zesty sync and its diff against the book of
the last report, the WhatsApp sync judged group by group (with one reconnect
and a backfill when a group reports a gap), what became of the last report's
orders, the scorecard and the events. It writes

  .whatsapp/reports/TODAY.run.json            what this run is: date, session, depth, diff
  .whatsapp/reports/TODAY.broker-orders.json  the broker's orders as read
  .whatsapp/reports/TODAY.orders-status.md    the last report's orders against the broker
  .whatsapp/reports/TODAY.scorecard.md
  .whatsapp/reports/TODAY.events.md

and prints the summary the analyst's prompt is filled from. Exit code 0: go
on. 2: stop, the analysis cannot be built (dashboard or MCP server down,
WhatsApp not linked, a group that will not sync). The Zesty login failing is
not a stop: the run goes on with the stored book and says so.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error

from marketdata import HEDGES, REPORTS, ROOT, Closes, api, last_session, load, ny_now, phase, report_files

TODAY = dt.date.today().isoformat()
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = lambda kind: os.path.join(REPORTS, f"{TODAY}.{kind}")  # noqa: E731


def say(line=""):
    print(line, flush=True)


def stop(why):
    say(f"\nSTOP: {why}")
    sys.exit(2)


def run(script, *args, to=None):
    """Run one of the report scripts; its output goes to `to` when given."""
    res = subprocess.run([sys.executable, os.path.join(HERE, script), *args], capture_output=True, text=True, cwd=ROOT)
    if to and res.returncode == 0:
        open(to, "w").write(res.stdout)
    return res


def depth(forced, reports, today=None):
    """WEEKLY on the first run after a week has closed (Saturday, or Sunday or
    Monday when Saturday's did not happen), or after a week with no report;
    DAILY otherwise. `reports` are the .md files dated before today."""
    today = today or dt.date.today()
    if forced or not reports:
        return "WEEKLY"
    newest = dt.date.fromisoformat(os.path.basename(reports[-1])[:10])
    if (today - newest).days > 7:
        return "WEEKLY"
    if today.weekday() not in (5, 6, 0):
        return "DAILY"
    # The Friday whose close ended the week: yesterday on a Saturday, three
    # days back on a Monday.
    friday = today - dt.timedelta(days=(today.weekday() - 4) % 7)
    for f in reports:
        if friday.isoformat() < os.path.basename(f)[:10] < today.isoformat():
            with open(f) as report:
                lines = report.read().splitlines()[:2]
            if len(lines) > 1 and "WEEKLY" in lines[1]:
                return "DAILY"
    return "WEEKLY"


def diff_book(before, after):
    """Lines saying what moved between the last report's book and now."""
    old = {p["ticker"]: p for p in before.get("positions", [])}
    new = {p["ticker"]: p for p in after.get("positions", [])}
    lines = []
    for t in sorted(set(old) | set(new)):
        a, b = old.get(t), new.get(t)
        if not a:
            lines.append(f"{t}: new position, {b['shares']:g} sh at ${b.get('avg_cost') or 0:,.2f}")
        elif not b:
            lines.append(f"{t}: closed ({a['shares']:g} sh gone)")
        elif abs(a["shares"] - b["shares"]) > 1e-6:
            lines.append(f"{t}: {a['shares']:g} → {b['shares']:g} sh, average cost "
                         f"${a.get('avg_cost') or 0:,.2f} → ${b.get('avg_cost') or 0:,.2f}")
        elif a.get("avg_cost") and b.get("avg_cost") and abs(a["avg_cost"] - b["avg_cost"]) > 0.005:
            lines.append(f"{t}: average cost ${a['avg_cost']:,.2f} → ${b['avg_cost']:,.2f}, shares unchanged")
    ca, cb = before.get("cash_balance"), after.get("cash_balance")
    if ca is not None and cb is not None and abs(ca - cb) > 0.005:
        lines.append(f"cash ${ca:,.2f} → ${cb:,.2f} ({cb - ca:+,.2f})")
    return lines


def zesty(sync):
    files = report_files(".portfolio.json")
    baseline_file = files[-1] if files else None
    before = load(baseline_file) if baseline_file else api("/api/portfolio")
    failed = None
    if sync:
        try:
            after = api("/api/portfolio/sync-zesty", method="POST", timeout=240)
        except urllib.error.HTTPError as e:
            failed = f"Zesty sync failed ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}"
            after = api("/api/portfolio")
        except Exception as e:
            failed = f"Zesty sync failed: {e}"
            after = api("/api/portfolio")
    else:
        after = api("/api/portfolio")
    book = api("/api/portfolio")
    orders = book.get("orders") or {"at": 0, "open": [], "closed": []}
    json.dump(orders, open(OUT("broker-orders.json"), "w"))
    lines = diff_book(before, after)
    say("## 1. Zesty")
    if failed:
        say(f"WARNING: {failed}. The analysis uses the last successful sync.")
    longs = [p for p in book["positions"] if p["ticker"] not in HEDGES]
    say(f"{len(book['positions'])} positions ({len(longs)} longs), cash ${book.get('cash_balance') or 0:,.2f}, "
        f"buying power ${book.get('buying_power') if book.get('buying_power') is not None else book.get('cash_balance') or 0:,.2f}")
    say(f"Change since {os.path.basename(baseline_file)[:10] if baseline_file else 'the stored book'}: "
        + ("; ".join(lines) if lines else "none"))
    stops = [o for o in orders["open"] if o["side"] == "sell" and "stop" in o["type"]]
    working = [o for o in orders["open"] if o not in stops]

    def fmt(o):
        lvl = (f"{o['trailPercent']:g}% trail (now ${o['stopPrice']:,.2f})" if o["type"] == "trailing_stop" and o.get("stopPrice")
               else f"${(o.get('stopPrice') or o.get('limitPrice') or 0):,.2f}")
        return f"{o['side'].upper()} {o.get('qty') or 0:g} {o['ticker']} {o['type']} {lvl}"

    say("Resting stops: " + ("; ".join(fmt(o) for o in stops) or "none"))
    say("Open buys and sells: " + ("; ".join(fmt(o) for o in working) or "none"))
    anchor = after.get("performance_anchor") if isinstance(after, dict) else None
    if anchor:
        say(f"Performance anchor: last deposit or withdrawal on record {anchor.get('lastFlowDate')}")
    return {"failed": failed, "diff": lines, "book": book, "stops": [fmt(o) for o in stops],
            "working": [fmt(o) for o in working], "anchor": anchor}


def wait_job():
    for _ in range(360):
        job = api("/api/whatsapp/sync-job").get("job")
        if not job or job["status"] != "running":
            return job
        time.sleep(5)
    return None


def sync_groups(groups, backfill=False):
    try:
        api("/api/whatsapp/sync-job", {"groups": groups, "backfill": backfill})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        if "en curso" not in text:  # a job already running is simply waited on
            return None, text
    job = wait_job()
    return job, None if job else "the sync did not finish in 30 minutes"


def reconnect():
    api("/api/whatsapp/disconnect", method="POST", body={})
    time.sleep(3)
    try:
        api("/api/whatsapp/connect", method="POST", body={}, timeout=120)
    except Exception as e:
        return str(e)
    for _ in range(36):
        if api("/api/whatsapp/status").get("status") == "connected":
            return None
        time.sleep(5)
    return "the client did not come back as connected"


def whatsapp(sync):
    say("\n## 2. WhatsApp")
    status = api("/api/whatsapp/status")
    if status.get("status") != "connected":
        stop(f"WhatsApp is '{status.get('status')}': open http://localhost:3000 and link it (a QR may be waiting)")
    groups = [{"jid": g["jid"], "name": g["name"]} for g in status.get("groups", []) if g.get("selected")]
    if not groups:
        stop("no group is selected for the analysis")
    if not sync:
        say("Sync skipped (--no-sync).")
        return {"groups": [], "reconnected": False, "backfilled": False}
    job, err = sync_groups(groups)
    bad = [g for g in (job or {}).get("groups", []) if g.get("status") == "error" or g.get("error")]
    reconnected = bool(job and job.get("reconnected"))
    if err or bad:
        say(f"First attempt failed ({err or '; '.join(str(g.get('error')) for g in bad)}): reconnecting once.")
        problem = reconnect()
        if problem:
            stop(f"WhatsApp reconnect failed: {problem}. If it says the browser is already running, an orphaned "
                 "session Chrome holds the lock: see the skill's step 2.")
        reconnected = True
        job, err = sync_groups(groups)
        bad = [g for g in (job or {}).get("groups", []) if g.get("status") == "error" or g.get("error")]
        if err or bad:
            stop(f"WhatsApp sync failed twice: {err or '; '.join(str(g.get('error')) for g in bad)}")
    backfilled = False
    if any(g.get("gap") for g in job["groups"]):
        say("A group stopped paging before the last sync's mark: running a 14-day backfill.")
        job2, err = sync_groups(groups, backfill=True)
        backfilled = True
        if job2 and not err:
            job = job2
    for g in job["groups"]:
        say(f"{g['name']}: +{g.get('newMessages', 0)} messages, +{g.get('newMedia', 0)} media"
            + (" (gap reported)" if g.get("gap") else ""))
    if reconnected:
        say("The client was restarted during the sync.")
    return {"groups": [{k: g.get(k) for k in ("name", "newMessages", "newMedia", "gap")} for g in job["groups"]],
            "reconnected": reconnected, "backfilled": backfilled}


def event_tickers(book):
    tickers = [p["ticker"] for p in book["positions"] if p["ticker"] not in HEDGES]
    try:
        tickers += [a["ticker"] for a in api("/api/main-analyst-adds").get("adds", []) if a.get("active")]
    except Exception:
        pass
    tickers += [o["ticker"] for o in (book.get("orders") or {}).get("open", [])]
    # The names the last report wanted to buy or was watching to buy: a new
    # position must not be opened into its own results without knowing it.
    prev = report_files(".json")
    if prev:
        tickers += [r["ticker"] for r in load(prev[-1], {}).get("recommendations", []) if r.get("action") == "BUY"]
    orders = report_files(".orders.json")
    if orders:
        tickers += [o["ticker"] for o in load(orders[-1], {}).get("orders", [])]
    seen = []
    for t in tickers:
        if t not in seen and t not in HEDGES:
            seen.append(t)
    return seen


def main():
    args = [a.lower() for a in sys.argv[1:]]
    sync = "--no-sync" not in args
    os.makedirs(REPORTS, exist_ok=True)
    now = ny_now()
    say(f"# Preflight for {TODAY} — New York {now:%a %d-%m %H:%M}, {phase(now)}")

    say("\n## 0. Dashboard and MCP server")
    try:
        api("/api/whatsapp/status", timeout=10)
    except Exception as e:
        stop(f"the dashboard does not answer ({e}): start it with `pnpm dev` and run this again")
    smoke = run("mcp-smoke.py")
    say(smoke.stdout.strip().splitlines()[-1] if smoke.stdout.strip() else "")
    if smoke.returncode != 0:
        stop(f"MCP smoke test failed: {(smoke.stderr or smoke.stdout).strip()[-300:]}")
    say("MCP server on disk: ok")

    earlier = [f for f in report_files(".md") if os.path.basename(f)[:10] < TODAY]
    z = zesty(sync)
    w = whatsapp(sync)

    say("\n## 3. Orders, scorecard, events")
    level = depth("weekly" in args, earlier)
    missing = []
    res = run("orders.py", to=OUT("orders-status.md"))
    if res.returncode != 0:
        missing.append(f"orders status ({(res.stderr or res.stdout).strip()[-120:]})")
    res = run("scorecard.py", *(["--review"] if level == "WEEKLY" else []), to=OUT("scorecard.md"))
    if res.returncode != 0:
        missing.append(f"scorecard ({(res.stderr or res.stdout).strip()[-120:]})")
    else:
        # The journal's payoff and profit factor, and the open positions past the loss cap or the time stop.
        res = subprocess.run(["pnpm", "exec", "tsx", "scripts/journal-stats.ts"], capture_output=True, text=True, cwd=ROOT)
        if res.returncode == 0:
            open(OUT("scorecard.md"), "a").write(res.stdout)
        else:
            missing.append(f"trade journal ({(res.stderr or res.stdout).strip()[-120:]})")
        # Each stop's room in ATRs, and the stop-outs of the last five sessions.
        res = run("volatility.py")
        if res.returncode == 0:
            open(OUT("scorecard.md"), "a").write(res.stdout)
        else:
            missing.append(f"volatility ({(res.stderr or res.stdout).strip()[-120:]})")
    tickers = event_tickers(z["book"])
    res = run("events.py", *tickers, to=OUT("events.md"))
    if res.returncode != 0:
        missing.append(f"events ({(res.stderr or res.stdout).strip()[-120:]})")
    say("Written: " + ", ".join(k for k in ("orders-status.md", "scorecard.md", "events.md") if os.path.exists(OUT(k))))
    if missing:
        say("Missing: " + "; ".join(missing))

    spy = Closes().of("SPY")
    session = last_session(spy, now)
    prev = os.path.basename(earlier[-1])[:10] if earlier else None
    days = max((dt.date.today() - dt.date.fromisoformat(prev)).days, 2) if prev else 7
    what = {
        "pre-market": f"the closes of {session}; the market has not opened",
        "open": f"live prices of an open session; the last close is {session}",
        "after the close": f"the closes of {session}",
        "weekend": f"the closes of {session}",
    }[phase(now)]
    record = {
        "date": TODAY, "session": session, "phase": phase(now), "startedNY": now.strftime("%Y-%m-%d %H:%M"),
        "depth": level, "previousReport": prev, "fullDetailDays": days, "pricesAre": what,
        "zesty": {k: z[k] for k in ("failed", "diff", "stops", "working", "anchor")},
        "cash": z["book"].get("cash_balance"), "buyingPower": z["book"].get("buying_power"),
        "whatsapp": w, "eventTickers": tickers, "missing": missing,
    }
    json.dump(record, open(OUT("run.json"), "w"), indent=1, ensure_ascii=False)

    say("\n## For the analyst's prompt")
    say(f"TODAY {TODAY} · DEPTH {level} · PREV {prev or 'none'} · fullDetailDays {days}")
    say(f"Session: {session}. Prices are {what}.")
    if phase(now) == "pre-market":
        say("A stop that waits for a daily close was decided on that close; a pre-market print decides nothing.")
    if phase(now) == "open":
        say("The market is open: a stop that waits for a close cannot be decided in this run.")
    say(f"Run record: {OUT('run.json')}")


if __name__ == "__main__":
    main()
