#!/usr/bin/env python3
"""Start the stock-recommender MCP server from the code on disk and call it.

  python3 scripts/mcp-smoke.py

A session keeps the MCP server it started with, so after a change to the
playbook, the tools or the database the session can be talking to old code
while the files say otherwise. This starts a fresh server over stdio, lists
its tools and calls the read-only ones the daily run depends on. Exit code 0
means the code on disk serves a full analysis bundle.
"""
import sys

from mcpclient import Server

NEEDED = ["corpus_status", "playbook", "portfolio", "main_analyst_adds", "analysis_bundle",
          "pending_media", "pending_relevance", "save_media_digest", "quotes", "sectors"]

failed = []
server = Server()
try:
    tools = [t["name"] for t in server.tools()]
    print(f"{len(tools)} tools: {', '.join(sorted(tools))}")
    for name in NEEDED:
        if name not in tools:
            failed.append(name)
            print(f"FAIL {name}: not registered")
    checks = [("corpus_status", {}), ("playbook", {}), ("main_analyst_adds", {}),
              ("portfolio", {"historyDays": 0}), ("analysis_bundle", {"fullDetailDays": 2})]
    for name, args in checks:
        ok, text = server.call(name, args)
        if not ok or not text:
            failed.append(name)
        print(f"{'ok  ' if ok and text else 'FAIL'} {name}: {len(text):,} chars" + ("" if ok else f" — {text[:200]}"))
        if name == "corpus_status":
            print("     " + " · ".join(l for l in text.splitlines() if l)[:300])
finally:
    server.close()

sys.exit(f"FAIL: {', '.join(failed)}" if failed else 0)
