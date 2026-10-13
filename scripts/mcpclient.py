"""A minimal stdio client for the stock-recommender MCP server.

It starts the server from the code on disk, so it always talks to the current
playbook, tools and database schema, whatever a long-lived session has loaded.
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Server:
    def __init__(self):
        self.proc = subprocess.Popen(
            [f"{ROOT}/node_modules/.bin/tsx", "--tsconfig", f"{ROOT}/tsconfig.json", f"{ROOT}/mcp/stdio.mts"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        self.seq = 0
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "mcpclient", "version": "1"}})
        self.rpc("notifications/initialized", notify=True)

    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self.seq += 1
            msg["id"] = self.seq
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        while not notify:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"the server exited before answering {method}")
            reply = json.loads(line)
            if reply.get("id") == self.seq:
                return reply

    def tools(self):
        return self.rpc("tools/list")["result"]["tools"]

    def call(self, name, args=None):
        """(ok, text) of one tool call."""
        reply = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        if "error" in reply:
            return False, reply["error"].get("message", str(reply["error"]))
        result = reply.get("result", {})
        text = "\n".join(c.get("text", "") for c in result.get("content") or [])
        return not result.get("isError"), text

    def close(self):
        self.proc.kill()
