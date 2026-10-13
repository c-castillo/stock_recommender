#!/usr/bin/env python3
"""Call one stock-recommender MCP tool from the shell.

  python3 scripts/mcp-call.py --list
  python3 scripts/mcp-call.py corpus_status
  python3 scripts/mcp-call.py quotes '{"tickers": ["CIEN", "MU"]}'
  python3 scripts/mcp-call.py save_media_digest @/path/to/args.json
  python3 scripts/mcp-call.py analysis_bundle '{"fullDetailDays": 2}' --out bundle.md

The fallback for a session whose MCP connection is down or stale: each call
starts the server from the code on disk, makes the call and prints the text.
Arguments are a JSON object, inline or `@file` (use a file for anything with
quotes or newlines). `--out FILE` writes the result there and prints its size.
"""
import json
import sys

from mcpclient import Server


def main():
    argv = sys.argv[1:]
    out = None
    if "--out" in argv:
        i = argv.index("--out")
        out = argv[i + 1]
        del argv[i:i + 2]
    if not argv:
        sys.exit(__doc__)
    server = Server()
    try:
        if argv[0] == "--list":
            for t in server.tools():
                props = ", ".join((t.get("inputSchema", {}).get("properties") or {}).keys())
                print(f"{t['name']}({props})")
            return 0
        raw = argv[1] if len(argv) > 1 else "{}"
        args = json.load(open(raw[1:])) if raw.startswith("@") else json.loads(raw)
        ok, text = server.call(argv[0], args)
        if out and ok:
            open(out, "w").write(text)
            print(f"{argv[0]}: {len(text):,} chars written to {out}")
        else:
            print(text)
        return 0 if ok else 1
    finally:
        server.close()


if __name__ == "__main__":
    sys.exit(main())
