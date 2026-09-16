# Stock Recommender

A [Next.js](https://nextjs.org) app that ingests WhatsApp trading-group messages, digests shared charts/PDFs, and produces AI-driven stock recommendations.

## Getting Started

This project uses [pnpm](https://pnpm.io). Install dependencies, then run the
development server:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Running the analysis from your phone

The dashboard only runs on the Mac (Next.js + a Chromium WhatsApp session + a
local SQLite file). `mcp/` exposes that same corpus over MCP so Claude on mobile
can run the analysis and write the report itself:

```bash
pnpm mcp         # MCP server on 127.0.0.1:3399, token from .env.local
pnpm mcp:tunnel  # publish it via cloudflared
```

On this machine it's already wired into Claude Code — `.mcp.json` registers the
stdio entrypoint and `.claude/agents/stock-analyst.md` drives it. Setup, the
tool list and the security caveats are in [mcp/README.md](mcp/README.md).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
