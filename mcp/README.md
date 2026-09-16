# The MCP server — running the analysis from your phone

The dashboard needs Next.js, a Chromium session and a local SQLite file, so it
only ever runs on the Mac. This server exposes that same data over MCP, so a
chat client — Claude on iOS/Android — can run the analysis itself and write the
report. The Mac stays the source of truth; the phone is a second front end.

```
iPhone (Claude app)
      │  custom connector, https://….trycloudflare.com/mcp/<token>
      ▼
cloudflared tunnel
      ▼
127.0.0.1:3399   mcp/http.mts   ← token-checked, loopback-bound
      ▼
.whatsapp/messages.db + wiki/ + /tmp/memories
```

Nothing here calls Claude. The server hands over context; the client does the
thinking. That means **media digesting still happens on the Mac** — chart and
PDF summaries are produced by Haiku at ingestion time, and `analysis_bundle`
warns you when files in the window have no digest yet.

## Tools

| Tool | Purpose |
|---|---|
| `playbook` | The frozen analyst instructions — read before writing a report |
| `analysis_bundle` | Everything Stage 3 sees, in one call (~7k tokens for a 7-day window) |
| `corpus_status` | Freshness check — catches a dead WhatsApp sync |
| `list_groups` | Synced groups with counts and date ranges |
| `search_messages` | Substring search over stored bodies |
| `media_digests` | Cached chart/PDF summaries |
| `portfolio` | Holdings, cash, live prices, MA200 slopes, goal, value history |
| `quotes` | Live price + MA200 slope for arbitrary tickers |
| `latest_report` | The stored recommendations, optionally the full narrative |
| `dr_cs_adds` | The active Dr CS watchlist |
| `record_dr_cs_add` / `deactivate_dr_cs_add` | The only writes this server allows |

Everything else — the corpus, the portfolio, the wiki — is read-only.

## On the Mac: Claude Code

Already wired up. `.mcp.json` registers the stdio entrypoint (`mcp/stdio.mts`),
which needs no token and no network. The `stock-analyst` agent in
`.claude/agents/` drives it:

```
> use the stock-analyst agent to run today's analysis
```

## On the phone: setup

### 1. Install a tunnel

```bash
brew install cloudflared
```

### 2. Start the server and the tunnel (two terminals, both must stay running)

```bash
pnpm mcp         # reads MCP_TOKEN from .env.local, binds 127.0.0.1:3399
pnpm mcp:tunnel  # prints https://<random>.trycloudflare.com
```

`pnpm mcp` prints the full connector URL with the token already in it.

### 3. Add the connector in the Claude mobile app

Settings → Connectors → Add custom connector, and paste:

```
https://<random>.trycloudflare.com/mcp/<your MCP_TOKEN>
```

### 4. Give it the instructions

The mobile app has no equivalent of `.claude/agents/`. Create a Project, paste
in `mcp/mobile-project-instructions.md`, and enable the connector for it. Then
"run today's analysis" behaves the way the agent does on desktop.

## Authentication, honestly

`MCP_TOKEN` lives in `.env.local` (gitignored) and is accepted two ways:
`Authorization: Bearer <token>`, or as a path segment — `/mcp/<token>`.

The path form exists because Claude's custom-connector UI takes a URL, not an
arbitrary header, and this server speaks plain bearer auth rather than OAuth.
**The connector URL is therefore a credential.** Anyone who has it can read
your WhatsApp corpus and portfolio. Don't paste it into a chat, a screenshot or
an issue. Rotate it with:

```bash
openssl rand -hex 32   # replace MCP_TOKEN in .env.local, restart pnpm mcp
```

Two further limits worth knowing:

- **A quick tunnel URL changes every restart**, so you re-add the connector each
  time. A named Cloudflare tunnel on a domain you own gives you a stable URL;
  worth it if you do this daily.
- **The Mac must be awake with both processes running.** Stop the tunnel and the
  connector goes dark — which is also the fastest way to revoke access.

The server binds to `127.0.0.1`, so only the tunnel process can reach it. Don't
change `MCP_HOST` to `0.0.0.0` unless you have a reason; it would expose the
port to your whole local network.
