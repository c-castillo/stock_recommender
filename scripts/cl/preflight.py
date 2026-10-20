#!/usr/bin/env python3
"""Everything the Chilean run does before a model is needed, in one command.

  python3 scripts/cl/preflight.py            # depth decided by the calendar
  python3 scripts/cl/preflight.py weekly     # force the weekly review
  python3 scripts/cl/preflight.py backfill   # sync the group with a 14-day backfill
  python3 scripts/cl/preflight.py --no-sync  # reuse what is stored (a re-run)

In order: the dashboard; a new Itaú statement, if one was dropped in the
project root or in ~/Downloads (`informeMensual*.pdf`), read into the book and
filed away; the WhatsApp sync of the IPSA group alone (one reconnect, and a
backfill when it reports a gap); the newest Telegram export of the Dividendos
Chile group (`~/Downloads/Telegram Desktop/ChatExport_*`), imported again
(idempotent); the depth. It writes

  .whatsapp/cl/reports/TODAY.run.json   what this run is: date, session, depth, statement

and prints the lines the analyst's prompt is filled from. Exit code 0: go on.
2: stop (dashboard down, WhatsApp not linked, the group will not sync).

The US preflight is not run and the US groups are not synced: the two books
share only the WhatsApp client.
"""
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys
import zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from marketdata import ROOT, api, get  # noqa: E402
from preflight import reconnect, sync_groups  # noqa: E402

GROUP = "IPSA & SCL 🇨🇱 Dr Market"
BENCHMARK = "CFMITNIPSA.SN"
CL = os.path.join(ROOT, ".whatsapp", "cl")
REPORTS = os.path.join(CL, "reports")
HOLDINGS = os.path.join(CL, "holdings")
SCL = zoneinfo.ZoneInfo("America/Santiago")
NOW = dt.datetime.now(SCL)
TODAY = NOW.date().isoformat()


def say(line=""):
    print(line, flush=True)


def stop(why):
    say(f"\nSTOP: {why}")
    sys.exit(2)


def tsx(*args):
    return subprocess.run(["pnpm", "exec", "tsx", *args], capture_output=True, text=True, cwd=ROOT)


def phase():
    minutes = NOW.hour * 60 + NOW.minute
    if NOW.weekday() >= 5:
        return "weekend"
    if minutes < 570:
        return "before the open"
    if minutes < 960:
        return "open"
    return "after the close"


def last_session():
    """The Santiago session the latest close belongs to, from the IPSA ETF."""
    try:
        r = json.loads(get(f"https://query1.finance.yahoo.com/v8/finance/chart/{BENCHMARK}?interval=1d&range=5d",
                           agent="Mozilla/5.0"))["chart"]["result"][0]
        days = [dt.datetime.fromtimestamp(t, SCL).date().isoformat() for t in r["timestamp"]]
        done = [d for d in days if d < TODAY or (d == TODAY and phase() == "after the close")]
        return done[-1] if done else None
    except Exception as e:  # the analyst can still read the bars' dates in the bundle
        say(f"(could not read the last session from Yahoo: {e})")
        return None


def stored_statements():
    return sorted(f[:10] for f in os.listdir(HOLDINGS) if f.endswith(".json") and len(f) == 15) \
        if os.path.isdir(HOLDINGS) else []


def statements():
    say("\n## 1. Itaú statement")
    found = sorted(set(glob.glob(os.path.join(ROOT, "informeMensual*.pdf"))
                       + glob.glob(os.path.expanduser("~/Downloads/informeMensual*.pdf"))), key=os.path.getmtime)
    before = stored_statements()
    for pdf in found:
        res = tsx("scripts/cl/holdings.ts", pdf, "--if-newer")
        if res.returncode == 0:
            say(f"Read {os.path.basename(pdf)}: " + res.stdout.strip().splitlines()[0])
        elif res.returncode == 3:
            say(res.stdout.strip())
        else:
            say(f"⚠ {os.path.basename(pdf)} could not be read and was left in place: "
                + (res.stderr or res.stdout).strip()[-300:])
    after = stored_statements()
    if not after:
        stop("no Itaú statement has been read: put the 'Informe Mensual de Cartera' PDF in the project root "
             "or in ~/Downloads and run this again")
    latest = after[-1]
    age = (NOW.date() - dt.date.fromisoformat(latest)).days
    new = latest not in before
    say(f"Book: statement of {latest} ({age} day(s) old){' — new this run' if new else ''}.")
    diff = []
    if new and before:
        old = json.load(open(os.path.join(HOLDINGS, before[-1] + ".json")))
        cur = json.load(open(os.path.join(HOLDINGS, latest + ".json")))
        a = {p["ticker"]: p["shares"] for p in old["positions"]}
        b = {p["ticker"]: p["shares"] for p in cur["positions"]}
        for t in sorted(set(a) | set(b)):
            if a.get(t, 0) != b.get(t, 0):
                diff.append(f"{t}: {a.get(t, 0):g} → {b.get(t, 0):g} sh")
        say("Change since the statement of " + before[-1] + ": " + ("; ".join(diff) or "no change in shares"))
    if age > 7:
        say(f"⚠ The statement is {age} days old: trades since then are not in the book.")
    return {"asOf": latest, "ageDays": age, "new": new, "diff": diff}


def whatsapp(sync, backfill):
    say("\n## 2. WhatsApp (IPSA group only)")
    status = api("/api/whatsapp/status")
    if status.get("status") != "connected":
        stop(f"WhatsApp is '{status.get('status')}': open http://localhost:3000 and link it (a QR may be waiting)")
    group = next(({"jid": g["jid"], "name": g["name"]} for g in status.get("groups", []) if g["name"] == GROUP), None)
    if not group:
        stop(f"the group '{GROUP}' is not in the account's group list")
    if not sync:
        say("Sync skipped (--no-sync).")
        return {"newMessages": None, "reconnected": False, "backfilled": False}
    job, err = sync_groups([group], backfill=backfill)
    bad = [g for g in (job or {}).get("groups", []) if g.get("status") == "error" or g.get("error")]
    reconnected = bool(job and job.get("reconnected"))
    if err or bad:
        say(f"First attempt failed ({err or '; '.join(str(g.get('error')) for g in bad)}): reconnecting once.")
        problem = reconnect()
        if problem:
            stop(f"WhatsApp reconnect failed: {problem}. If it says the browser is already running, an orphaned "
                 "session Chrome holds the lock: see the daily-run skill's step 0 to 3.")
        reconnected = True
        job, err = sync_groups([group], backfill=backfill)
        bad = [g for g in (job or {}).get("groups", []) if g.get("status") == "error" or g.get("error")]
        if err or bad:
            stop(f"WhatsApp sync failed twice: {err or '; '.join(str(g.get('error')) for g in bad)}")
    g = job["groups"][0]
    if g.get("gap") and not backfill:
        say("The group stopped paging before the last sync's mark: running a 14-day backfill.")
        job2, err = sync_groups([group], backfill=True)
        backfill = True
        if job2 and not err:
            g = job2["groups"][0]
    say(f"{g['name']}: +{g.get('newMessages', 0)} messages, +{g.get('newMedia', 0)} media"
        + (" (gap reported)" if g.get("gap") else ""))
    return {"newMessages": g.get("newMessages"), "newMedia": g.get("newMedia"), "gap": g.get("gap"),
            "reconnected": reconnected, "backfilled": backfill}


def telegram():
    say("\n## 3. Telegram (Dividendos Chile, from the newest export)")
    res = tsx("scripts/cl/telegram.ts")
    if res.returncode == 2:
        say("No Telegram export found in ~/Downloads/Telegram Desktop: the run goes on with what is stored.")
        return {"imported": False}
    if res.returncode != 0:
        say("⚠ The Telegram import failed and the run goes on with what is stored: " + (res.stderr or res.stdout).strip()[-300:])
        return {"imported": False}
    say(res.stdout.strip())
    found = re.search(r"→ (\d{4}-\d{2}-\d{2})\)", res.stdout)
    newest = found.group(1) if found else None
    age = (NOW.date() - dt.date.fromisoformat(newest)).days if newest else None
    if age is not None and age > 3:
        say(f"⚠ The newest Telegram message is {age} days old: export the group again from Telegram Desktop "
            "(Export chat history, HTML, photos) into ~/Downloads/Telegram Desktop.")
    return {"imported": True, "newest": newest, "ageDays": age, "summary": res.stdout.strip()}


def depth(forced, prev):
    """WEEKLY on Friday (the week's last session) and at the weekend, on the
    first report, or when the last report is over a week old; DAILY otherwise."""
    if forced or prev is None or NOW.weekday() >= 4:
        return "WEEKLY"
    if (NOW.date() - dt.date.fromisoformat(prev)).days > 7:
        return "WEEKLY"
    return "DAILY"


def main():
    args = [a.lower() for a in sys.argv[1:]]
    os.makedirs(REPORTS, exist_ok=True)
    say(f"# Chilean preflight for {TODAY} — Santiago {NOW:%a %d-%m %H:%M}, {phase()}")

    say("\n## 0. Dashboard")
    try:
        api("/api/whatsapp/status", timeout=10)
    except Exception as e:
        stop(f"the dashboard does not answer ({e}): start it with `pnpm dev` and run this again")
    say("Dashboard: ok")

    st = statements()
    wa = whatsapp("--no-sync" not in args, "backfill" in args)
    tg = telegram()
    status = tsx("scripts/cl/corpus.ts", "status")
    say(status.stdout.strip())

    earlier = sorted(f[:10] for f in os.listdir(REPORTS) if len(f) == 13 and f.endswith(".md") and f[:10] < TODAY)
    prev = earlier[-1] if earlier else None
    level = depth("weekly" in args, prev)
    days = max((NOW.date() - dt.date.fromisoformat(prev)).days, 2) if prev else 7
    session = last_session()
    what = {
        "before the open": f"the closes of {session}; Santiago has not opened",
        "open": f"live prices of an open session; the last close is {session}",
        "after the close": f"the closes of {session}",
        "weekend": f"the closes of {session}",
    }[phase()]
    record = {"date": TODAY, "session": session, "phase": phase(), "startedSantiago": NOW.strftime("%Y-%m-%d %H:%M"),
              "depth": level, "previousReport": prev, "fullDetailDays": days, "pricesAre": what,
              "statement": st, "whatsapp": wa, "telegram": tg}
    path = os.path.join(REPORTS, f"{TODAY}.run.json")
    json.dump(record, open(path, "w"), indent=1, ensure_ascii=False)

    say("\n## For the analyst's prompt")
    say(f"TODAY {TODAY} · DEPTH {level} · PREV {prev or 'none'} · fullDetailDays {days}")
    say(f"Session: {session}. Prices are {what}.")
    say(f"Book: Itaú statement of {st['asOf']} ({st['ageDays']} day(s) old)"
        + (f"; changed since the last statement: {'; '.join(st['diff'])}" if st["diff"] else ""))
    if phase() == "open":
        say("Santiago is open: a stop that waits for a close cannot be decided in this run.")
    say(f"Run record: {path}")


if __name__ == "__main__":
    main()
