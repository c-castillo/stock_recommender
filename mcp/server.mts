/**
 * MCP server exposing this app's WhatsApp corpus, portfolio and analyst
 * playbook, so a chat client can run the investment analysis without the
 * Next.js dashboard — the point being to drive it from a phone.
 *
 * Everything here delegates to the same modules the in-app pipeline uses
 * (lib/whatsapp/db, lib/ai/content-loader, lib/ai/portfolio-context,
 * lib/ai/playbook). No query logic is re-implemented, so the report a client
 * produces from `analysis_bundle` sees exactly what Stage 3 sees.
 *
 * What it deliberately does NOT do: call Claude. Stage 1 media digesting is an
 * ingestion-time job on the machine that holds the WhatsApp session; this
 * server only reports which digests already exist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listGroups,
  listSelectedJids,
  countSelectedGroups,
  countAllMessages,
  countAllMedia,
  getOldestMessage,
  getNewestMessage,
  getRecentMessages,
  getContentForAnalysis,
  listPortfolio,
  getCashBalance,
  getPortfolioGoal,
  getPortfolioHistory,
  listActiveDrCsAdds,
  recordDrCsAdd,
  deactivateDrCsAdd,
  loadAiRecommendations,
  getAnalysisCache,
} from "@/lib/whatsapp/db";
import {
  loadAnalysisInputs,
  renderTextBlock,
  renderMediaDigestBlock,
  renderDrCsAddLedger,
} from "@/lib/ai/content-loader";
import { buildPortfolioContext } from "@/lib/ai/portfolio-context";
import { SYSTEM_PROMPT } from "@/lib/ai/playbook";
import { loadAllWikis } from "@/lib/ai/wiki";
import { readAllMemories } from "@/lib/ai/memory-store";
import { fetchCurrentPrices } from "@/lib/market/quotes";
import { fetchMa200Slopes } from "@/lib/ma200";

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/** Media in the window that sync never digested — the analysis can't see it. */
function countUndigestedMedia(days: number): number {
  return getContentForAnalysis(days, 6000).filter(
    (r) =>
      (r.media_type === "image" || r.media_type === "document") &&
      r.media_digest == null
  ).length;
}

// ── Server ────────────────────────────────────────────────────────────────────

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "stock-recommender", version: "1.0.0" },
    {
      instructions:
        "WhatsApp trading-group corpus + portfolio for a trend-following US-equity " +
        "analyst. To produce the daily report: call `playbook` for the rules, then " +
        "`analysis_bundle` for the full context in one shot, and write the report " +
        "from those. Use the narrower tools (`search_messages`, `portfolio`, " +
        "`quotes`) for follow-up questions. Record a Dr CS ADD in the ledger with " +
        "`record_dr_cs_add` — never by editing a past report.",
    }
  );

  // ── The one-shot context for a full analysis ────────────────────────────────

  server.registerTool(
    "analysis_bundle",
    {
      title: "Analysis bundle",
      description:
        "Everything needed to write the investment report, in one call: the active " +
        "Dr CS ADD ledger, relevance-filtered WhatsApp messages, cached chart/PDF " +
        "digests, portfolio with live prices and MA200 slopes, prior-run history and " +
        "cross-session memory. This is the same context the in-app Stage-3 synthesis " +
        "receives. Pair it with `playbook`.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(7)
          .describe("Look-back window in days. The app uses 7."),
        includeHistory: z
          .boolean()
          .default(true)
          .describe("Include the per-ticker wiki (last verdict per ticker) and prior-session memory."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days, includeHistory }) => {
      const { textRows, mediaRows, stats } = loadAnalysisInputs(days);

      if (stats.textMessages === 0 && stats.images === 0 && stats.documents === 0) {
        return text(
          countSelectedGroups() === 0
            ? "No groups are selected for analysis, so the corpus is empty regardless of " +
              "what has been downloaded. Select at least one in the dashboard — newly " +
              "discovered groups arrive unselected by design."
            : `No content in the last ${days} days. The WhatsApp sync on the host machine ` +
              `is probably stopped — check the dashboard, or widen \`days\`.`
        );
      }

      const undigested = countUndigestedMedia(days);
      const portfolio = await buildPortfolioContext();

      const header =
        `# Analysis bundle — ${new Date().toISOString().slice(0, 10)}, last ${days} day(s)\n` +
        `Sources: ${stats.textMessages} text messages · ${stats.images} images · ` +
        `${stats.documents} PDFs · ${stats.groups.length} group(s): ${stats.groups.join(", ")}\n` +
        (undigested > 0
          ? `\n> ⚠️ ${undigested} media file(s) in this window have no digest and are NOT ` +
            `included below. Digesting runs at ingestion on the host machine — run the ` +
            `analysis there (\`pnpm analyze\`) to fold them in.\n`
          : "");

      const history = includeHistory
        ? (() => {
            const wikis = loadAllWikis();
            const memory = readAllMemories();
            return (
              (wikis ? "\n" + wikis : "") +
              (memory.trim() ? `\n## Memory from prior sessions\n${memory}\n` : "")
            );
          })()
        : "";

      return text(
        header +
          renderDrCsAddLedger() +
          renderTextBlock(textRows) +
          renderMediaDigestBlock(mediaRows) +
          portfolio +
          history
      );
    }
  );

  // ── The frozen rules ────────────────────────────────────────────────────────

  server.registerTool(
    "playbook",
    {
      title: "Analyst playbook",
      description:
        "The frozen analyst instructions — philosophy, methodology, the Dr CS ADD " +
        "override and the required report shape. Read this before writing a report.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(SYSTEM_PROMPT)
  );

  // ── Corpus ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_groups",
    {
      title: "List WhatsApp groups",
      description:
        "Synced groups that actually hold messages, with counts, stored date range " +
        "and whether they are selected for analysis. Most of the linked account's " +
        "groups are empty chatter that was never backfilled — pass includeEmpty to " +
        "see them too.",
      inputSchema: {
        includeEmpty: z
          .boolean()
          .default(false)
          .describe("Also list groups with zero stored messages."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeEmpty }) => {
      const all = listGroups().map((g) => ({ ...g, count: countAllMessages(g.jid) }));
      const groups = (includeEmpty ? all : all.filter((g) => g.count > 0)).sort(
        (a, b) => b.count - a.count
      );
      if (groups.length === 0) {
        return text(
          all.length === 0
            ? "No groups synced yet."
            : `None of the ${all.length} synced groups have stored messages — run a history sync from the dashboard.`
        );
      }
      const rows = groups.map((g) => {
        const oldest = getOldestMessage(g.jid);
        const newest = getNewestMessage(g.jid);
        const range =
          oldest && newest ? `${fmtTs(oldest.ts)} → ${fmtTs(newest.ts)}` : "—";
        return (
          `${g.selected ? "✓" : " "} ${g.name}\n` +
          `    jid: ${g.jid}\n` +
          `    ${g.count} messages · ${countAllMedia(g.jid)} media · ${range}`
        );
      });
      const hidden = all.length - groups.length;
      return text(
        `Groups with content (✓ = analysed):\n\n${rows.join("\n\n")}\n\n` +
          `Selected for analysis: ${listSelectedJids().length}/${all.length} synced group(s)` +
          (hidden > 0 ? ` · ${hidden} empty group(s) hidden` : "")
      );
    }
  );

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description:
        "Case-insensitive substring search over stored message bodies, newest first. " +
        "Use it to answer 'what did the group say about NVDA' without pulling a whole " +
        "bundle. Omit `query` to just list the most recent messages.",
      inputSchema: {
        query: z.string().optional().describe("Substring to match, e.g. a ticker."),
        days: z.number().int().min(1).max(365).default(30).describe("Look-back window."),
        jid: z.string().optional().describe("Restrict to one group JID."),
        limit: z.number().int().min(1).max(400).default(60),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, days, jid, limit }) => {
      const rows = getRecentMessages(days, jid ? [jid] : undefined);
      const needle = query?.toLowerCase();
      const hits = (needle ? rows.filter((r) => r.body.toLowerCase().includes(needle)) : rows).slice(
        0,
        limit
      );
      if (hits.length === 0) {
        return text(`No matches for ${query ? `"${query}" ` : ""}in the last ${days} days.`);
      }
      const names = new Map(listGroups().map((g) => [g.jid, g.name]));
      return text(
        `${hits.length} message(s)${query ? ` matching "${query}"` : ""}, last ${days} days:\n\n` +
          hits
            .map(
              (r) =>
                `[${fmtTs(r.ts)}] ${names.get(r.jid) ?? r.jid} · ${r.sender ?? "?"}: ${r.body}`
            )
            .join("\n")
      );
    }
  );

  server.registerTool(
    "media_digests",
    {
      title: "Chart & PDF digests",
      description:
        "Cached one-line digests of charts and PDF reports shared in the groups — " +
        "ticker, signal, levels, summary. These are what the analysis sees in place " +
        "of the raw images.",
      inputSchema: {
        days: z.number().int().min(1).max(60).default(7),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const rows = getContentForAnalysis(days, 6000).filter(
        (r) => r.media_digest != null && (r.media_type === "image" || r.media_type === "document")
      );
      if (rows.length === 0) return text(`No digested media in the last ${days} days.`);
      const undigested = countUndigestedMedia(days);
      return text(
        renderMediaDigestBlock(rows) +
          (undigested > 0 ? `\n(${undigested} further file(s) not yet digested.)` : "")
      );
    }
  );

  // ── Portfolio & market ──────────────────────────────────────────────────────

  server.registerTool(
    "portfolio",
    {
      title: "Portfolio",
      description:
        "Current holdings with live prices and MA200 slopes, cash balance, the " +
        "savings goal, and recent total-value history. Same rendering the analysis " +
        "prompt gets, so position-sizing rules apply directly.",
      inputSchema: {
        historyDays: z.number().int().min(0).max(365).default(14),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ historyDays }) => {
      const section = await buildPortfolioContext();
      const goal = getPortfolioGoal();
      const goalLine = goal
        ? `\n## Goal\n$${goal.amount.toLocaleString("en-US")} by ${goal.deadline}\n`
        : "";
      const history = historyDays
        ? getPortfolioHistory(historyDays)
            .map(
              (h) =>
                `${h.date}|$${h.total_value.toFixed(0)}|$${h.market_value.toFixed(0)}|$${h.cash_balance.toFixed(0)}`
            )
            .join("\n")
        : "";
      return text(
        section +
          goalLine +
          (history ? `\n## Total value history\nDate|Total|Market|Cash\n---|---|---|---\n${history}\n` : "")
      );
    }
  );

  server.registerTool(
    "quotes",
    {
      title: "Live quotes",
      description:
        "Live price and 200-day-MA slope (% change over 20 trading days) for any " +
        "tickers. MA200 slope up = long bias, down = avoid or short.",
      inputSchema: {
        tickers: z.array(z.string()).min(1).max(25).describe("e.g. ['NVDA','SPY']"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tickers }) => {
      const symbols = tickers.map((t) => t.trim().toUpperCase()).filter(Boolean);
      const [prices, slopes] = await Promise.all([
        fetchCurrentPrices(symbols),
        fetchMa200Slopes(symbols),
      ]);
      return text(
        "Ticker|Price|MA200 slope\n---|---|---\n" +
          symbols
            .map((t) => {
              const p = prices[t];
              const s = slopes[t];
              return `${t}|${p != null ? `$${p.toFixed(2)}` : "—"}|${
                s != null ? `${s >= 0 ? "↑+" : "↓"}${s.toFixed(2)}%` : "—"
              }`;
            })
            .join("\n")
      );
    }
  );

  // ── Reports ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "latest_report",
    {
      title: "Latest stored report",
      description:
        "The most recent analysis: its structured BUY/SELL/HOLD recommendations and, " +
        "if still cached, the full narrative. Use it to compare against today rather " +
        "than re-deriving yesterday's view.",
      inputSchema: {
        includeNarrative: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeNarrative }) => {
      const recs = loadAiRecommendations();
      if (recs.length === 0) return text("No stored recommendations yet.");
      const when = new Date(recs[0].generatedAt * 1000).toISOString().slice(0, 16).replace("T", " ");
      const table =
        `# Stored recommendations (generated ${when} UTC)\n\n` +
        "Action|Ticker|Conf|Entry|Target|Stop|Reasoning\n---|---|---|---|---|---|---\n" +
        recs
          .map(
            (r) =>
              `${r.action}|${r.ticker}|${r.confidence}|${r.entryPrice ?? "—"}|` +
              `${r.priceTarget ?? "—"}|${r.stopLoss ?? "—"}|${r.reasoning.replace(/\|/g, "/")}`
          )
          .join("\n");
      const cached = includeNarrative ? getAnalysisCache() : null;
      return text(
        table + (cached?.narrative ? `\n\n---\n\n# Narrative\n\n${cached.narrative}` : "")
      );
    }
  );

  // ── Dr CS ADD ledger (the only writable surface) ─────────────────────────────

  server.registerTool(
    "dr_cs_adds",
    {
      title: "Dr CS ADD ledger",
      description:
        "Active Dr CS watchlist adds. Each row stays live — strongest bullish signal, " +
        "never a SELL — until Dr CS issues an explicit sell.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const adds = listActiveDrCsAdds();
      if (adds.length === 0) return text("No active Dr CS ADDs.");
      return text(
        "Ticker|Entry|Added|Note\n---|---|---|---\n" +
          adds
            .map((a) => `${a.ticker}|${a.entryPrice ?? "—"}|${a.addedOn ?? "—"}|${a.note ?? ""}`)
            .join("\n")
      );
    }
  );

  server.registerTool(
    "record_dr_cs_add",
    {
      title: "Record a Dr CS ADD",
      description:
        "Add (or re-activate) a ticker in the Dr CS ledger so every future analysis " +
        "treats it as a live [★ DR CS ADD]. Use this when Dr CS adds a name by voice, " +
        "image or chat rather than a '+TICKER' message. Idempotent per ticker.",
      inputSchema: {
        ticker: z.string().describe("e.g. NVDA"),
        entryPrice: z.string().optional().describe("e.g. '$182.40'"),
        note: z.string().optional().describe("Why — the thesis in a line."),
        addedOn: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async ({ ticker, entryPrice, note, addedOn }) => {
      recordDrCsAdd({ ticker, entryPrice, note, addedOn });
      return text(
        `Recorded ${ticker.toUpperCase()}. Active ADDs: ` +
          listActiveDrCsAdds().map((a) => a.ticker).join(", ")
      );
    }
  );

  server.registerTool(
    "deactivate_dr_cs_add",
    {
      title: "Close a Dr CS ADD",
      description:
        "Deactivate a ticker in the Dr CS ledger — only when Dr CS issues a SELL or " +
        "the thesis is closed. An unrealised loss or a negative MA200 is NOT a reason.",
      inputSchema: { ticker: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    async ({ ticker }) => {
      deactivateDrCsAdd(ticker);
      const left = listActiveDrCsAdds().map((a) => a.ticker);
      return text(
        `Deactivated ${ticker.toUpperCase()}. Still active: ${left.length ? left.join(", ") : "none"}`
      );
    }
  );

  // ── Health ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "corpus_status",
    {
      title: "Corpus status",
      description:
        "Freshness check: how recent the newest stored message is, and how much " +
        "content sits in the analysis window. Call this first if a report looks stale — " +
        "a gap means the sync on the host machine stopped.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const selected = listSelectedJids();
      const groups = listGroups().filter((g) => selected.includes(g.jid));
      const newest = groups
        .map((g) => getNewestMessage(g.jid)?.ts ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const ageHours = newest ? (Date.now() / 1000 - newest) / 3600 : null;
      const { stats } = loadAnalysisInputs(7);
      return text(
        `Selected groups: ${groups.length}\n` +
          `Newest message: ${newest ? `${fmtTs(newest)} (${ageHours!.toFixed(1)}h ago)` : "none"}\n` +
          `Last 7 days: ${stats.textMessages} relevant messages · ${stats.images} images · ` +
          `${stats.documents} PDFs\n` +
          `Undigested media (7d): ${countUndigestedMedia(7)}\n` +
          `Cash on record: ${getCashBalance() != null ? `$${getCashBalance()!.toLocaleString("en-US")}` : "not set"}\n` +
          `Positions: ${listPortfolio().length}\n` +
          (ageHours != null && ageHours > 24
            ? `\n⚠️ The corpus is over a day stale — the WhatsApp sync is likely down.`
            : "")
      );
    }
  );

  return server;
}
