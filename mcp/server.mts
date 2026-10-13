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
import fs from "fs";

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
  setMediaDigest,
  listPortfolio,
  getCashBalance,
  getPortfolioHistory,
  listGroupJidsByName,
  listUnclassifiedForReview,
  getUnclassifiedBodies,
  setRelevanceByRowid,
  listActiveMainAnalystAdds,
  recordMainAnalystAdd,
  deactivateMainAnalystAdd,
  loadAiRecommendations,
  getAnalysisCache,
} from "@/lib/whatsapp/db";
import {
  loadAnalysisInputs,
  renderTextBlock,
  renderMediaDigestBlock,
  renderMainAnalystAddLedger,
  loadMainAnalystAddLedger,
} from "@/lib/ai/content-loader";
import { buildPortfolioContext } from "@/lib/ai/portfolio-context";
import { classifyTickers, renderSectorLookup } from "@/lib/market/classify";
import { SECTORS } from "@/lib/market/sectors";
import { SYSTEM_PROMPT } from "@/lib/ai/playbook";
import { digestSchema, PROMPT as DIGEST_PROMPT, STUDIES_PROMPT, TRANSCRIBE_PROMPT } from "@/lib/ai/media-prompts";
import { loadAllWikis } from "@/lib/ai/wiki";
import { readAllMemories } from "@/lib/ai/memory-store";
import { fetchCurrentPrices } from "@/lib/market/quotes";
import { fetchRecentFilings, renderFilingsBlock } from "@/lib/market/filings";
import { PRUNABLE_GROUPS } from "@/lib/whatsapp/analysis-groups";
import { RELEVANCE_INSTRUCTIONS } from "@/lib/ai/relevance";
import { hasExplicitFinanceContent } from "@/lib/whatsapp/noise";
import { fetchMa200Slopes } from "@/lib/ma200";

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Today's date on the host's clock. toISOString() is UTC, which is already
 *  tomorrow during an evening run in Chile. */
function localDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Same look-back the in-app Stage 3 uses — wide enough to catch a quarter's print. */
const FILINGS_WINDOW_DAYS = 45;

/** The Haiku pass's rules, minus its output-format line (the tool call is the format). */
const RELEVANCE_RULES = RELEVANCE_INSTRUCTIONS.replace(/\n\nReturn one verdict per message[\s\S]*$/, "");

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
        "`quotes`) for follow-up questions. Record a main analyst ADD in the ledger with " +
        "`record_main_analyst_add` — never by editing a past report.",
    }
  );

  // ── The one-shot context for a full analysis ────────────────────────────────

  server.registerTool(
    "analysis_bundle",
    {
      title: "Analysis bundle",
      description:
        "Everything needed to write the investment report, in one call: the active " +
        "main analyst ADD ledger, relevance-filtered WhatsApp messages, cached chart/PDF " +
        "digests, recent SEC filings for held and ADD tickers, portfolio with live " +
        "prices and MA200 slopes, prior-run history and cross-session memory. This is " +
        "the same context the in-app Stage-3 synthesis receives. Pair it with `playbook`. " +
        "The result is large and is usually saved to a file: read that file in a few big " +
        "sequential chunks issued together in ONE turn, not a dozen small ones.",
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
        fullDetailDays: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Print verbatim media transcripts only for the last N days; older files keep " +
              "their summary and study lines. Set it to the days since the previous report " +
              "(minimum 2). Omit for every transcript in the window."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days, includeHistory, fullDetailDays }) => {
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
      // Company events the corpus cannot see (earnings, 8-Ks), bounded to what
      // is held or on the ADD ledger — the same fan-out the in-app run does.
      const eventTickers = [
        ...listPortfolio().map((p) => p.ticker),
        ...listActiveMainAnalystAdds().map((a) => a.ticker),
      ];
      const [portfolio, filings] = await Promise.all([
        buildPortfolioContext(),
        fetchRecentFilings(eventTickers, FILINGS_WINDOW_DAYS),
      ]);
      const transcriptSince =
        fullDetailDays != null && fullDetailDays < days
          ? Math.floor(Date.now() / 1000) - fullDetailDays * 86400
          : undefined;

      const header =
        `# Analysis bundle — ${localDate()}, last ${days} day(s)\n` +
        `Sources: ${stats.textMessages} text messages · ${stats.images} images · ` +
        `${stats.documents} PDFs · ${stats.groups.length} group(s): ${stats.groups.join(", ")}\n` +
        (undigested > 0
          ? `\n> ⚠️ ${undigested} media file(s) in this window have no digest and are NOT ` +
            `included below. Call \`pending_media\`, read each file, save it with ` +
            `\`save_media_digest\`, then call \`analysis_bundle\` again.\n`
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
          renderMainAnalystAddLedger(await loadMainAnalystAddLedger()) +
          renderFilingsBlock(filings, FILINGS_WINDOW_DAYS) +
          renderTextBlock(textRows) +
          renderMediaDigestBlock(mediaRows, { transcriptSince }) +
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
        "The frozen analyst instructions — philosophy, methodology, the main analyst ADD " +
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

  // Media is downloaded at sync but no longer digested there (that billed API
  // credits per chart). The analyst reads each file itself — the Read tool
  // takes the absolute path — and saves the result, so every file is read once.
  server.registerTool(
    "pending_media",
    {
      title: "Media awaiting a digest",
      description:
        "Charts, screenshots and PDFs in the window that nobody has read yet — the " +
        "analysis cannot see them until they are digested. Returns each file's id, " +
        "absolute path, group, sender, time and caption, plus the digest instructions. " +
        "Read each file with the Read tool, then call `save_media_digest` for it.",
      inputSchema: {
        days: z.number().int().min(1).max(60).default(7),
        limit: z.number().int().min(1).max(100).default(40),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, limit }) => {
      const pending = getContentForAnalysis(days, 8000)
        .filter(
          (r) =>
            r.media_path &&
            r.media_digest == null &&
            (r.media_type === "image" || r.media_type === "document") &&
            fs.existsSync(r.media_path)
        )
        .sort((a, b) => b.ts - a.ts);
      if (pending.length === 0) return text(`No undigested media in the last ${days} days.`);
      const batch = pending.slice(0, limit);
      const list = batch
        .map(
          (r) =>
            `- id: ${r.id}\n  path: ${r.media_path}\n  ${r.media_type} (${r.media_mime ?? "?"}) · ` +
            `${fmtTs(r.ts)} · "${r.group_name}" · ${r.sender ?? "?"}` +
            (r.body && !/^\[(image|document|video|audio)\]$/.test(r.body)
              ? `\n  caption: ${r.body.replace(/\s+/g, " ").slice(0, 300)}`
              : "")
        )
        .join("\n");
      return text(
        `## ${pending.length} file(s) awaiting a digest` +
          (pending.length > batch.length ? ` (showing newest ${batch.length})` : "") +
          `\n\n${list}\n\n` +
          "## How to digest each file\n" +
          DIGEST_PROMPT +
          "\n\nFor charts carrying DeMark or Fibonacci studies, read them with the " +
          "technical-analysis, fibonacci-charts and demark-charts skills and follow these rules:\n" +
          STUDIES_PROMPT +
          "\n\nSet text_heavy=true when the file's information is mostly text or numbers " +
          "(tweets, news, chat screenshots, broker notes, tables, screeners, calendars) and " +
          "fill `transcript` following these rules:\n" +
          TRANSCRIBE_PROMPT
      );
    }
  );

  server.registerTool(
    "save_media_digest",
    {
      title: "Save a media digest",
      description:
        "Store your reading of one file from `pending_media`. Once saved it appears in " +
        "`analysis_bundle` and `media_digests` like any other digest, for this and every " +
        "later run (including the web dashboard's).",
      inputSchema: {
        id: z.string().describe("The file's id from pending_media"),
        ...digestSchema.shape,
        transcript: z
          .string()
          .optional()
          .describe("Verbatim text when text_heavy is true (per the transcription rules)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, transcript, ...digest }) => {
      const row = getContentForAnalysis(60, 20000).find((r) => r.id === id);
      if (!row) return text(`No media message with id ${id} in the last 60 days.`);
      const stored: Record<string, unknown> = { ...digest, digested_by: "claude-code" };
      if (digest.text_heavy && transcript?.trim()) stored.transcript = transcript.trim();
      setMediaDigest(id, JSON.stringify(stored));
      return text(`Saved digest for ${id}${stored.transcript ? " (with transcript)" : ""}.`);
    }
  );

  // ── Noise marking ───────────────────────────────────────────────────────────
  //
  // The same Stage 0b the in-app run does with Haiku on the API key
  // (lib/ai/relevance.ts), done here by the chat client on the user's plan.
  // Same safety model: it MARKS, never deletes; only PRUNABLE_GROUPS are ever
  // listed; a message left out of the verdict call stays unclassified, which
  // reads as relevant.

  server.registerTool(
    "pending_relevance",
    {
      title: "Messages awaiting a relevance verdict",
      description:
        "Text messages in the mixed groups that nobody has classified as market-relevant " +
        "or off-topic chatter yet. Until they are, all of them go into the analysis. " +
        "Returns `rowid: text` lines plus the rules. Classify them and call `save_relevance`.",
      inputSchema: {
        limit: z.number().int().min(1).max(400).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const jids = listGroupJidsByName(PRUNABLE_GROUPS);
      const rows = listUnclassifiedForReview(jids, limit + 1);
      if (rows.length === 0) return text("No messages awaiting a relevance verdict.");
      const batch = rows.slice(0, limit);
      // Oldest first, so replies read after what they answer.
      const lines = [...batch]
        .reverse()
        .map((r) => `${r.rowid}: ${r.body.replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n");
      return text(
        `## ${batch.length} message(s) to classify` +
          (rows.length > limit ? " (more remain — call again after saving)" : "") +
          `\nGroups: ${PRUNABLE_GROUPS.join(", ")}\n\n` +
          RELEVANCE_RULES +
          "\n\nThe number before each message is its rowid. Put every rowid in exactly one of " +
          "`save_relevance`'s two lists.\n\n" +
          lines
      );
    }
  );

  server.registerTool(
    "save_relevance",
    {
      title: "Save relevance verdicts",
      description:
        "Store verdicts for messages from `pending_relevance`. `noise` rows are hidden from " +
        "future analyses (not deleted); `relevant` rows stay in. A message with an explicit " +
        "price, percentage, $TICKER or finance term is kept as relevant whatever you say.",
      inputSchema: {
        relevant: z.array(z.number().int()).describe("rowids that could inform a recommendation"),
        noise: z.array(z.number().int()).describe("rowids that are off-topic chatter"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async ({ relevant, noise }) => {
      const jids = listGroupJidsByName(PRUNABLE_GROUPS);
      // Only rows that are still pending in a prunable group can be written.
      const pending = new Map(
        getUnclassifiedBodies(jids, [...relevant, ...noise]).map((r) => [r.rowid, r.body])
      );
      const relevantSet = new Set(relevant);
      let protectedCount = 0;
      const verdicts: { rowid: number; relevant: boolean }[] = [];
      for (const [rowid, body] of pending) {
        // A row named in both lists is kept: when unsure, relevant.
        let isRelevant = relevantSet.has(rowid);
        if (!isRelevant && hasExplicitFinanceContent(body)) {
          isRelevant = true;
          protectedCount++;
        }
        verdicts.push({ rowid, relevant: isRelevant });
      }
      const saved = setRelevanceByRowid(verdicts);
      const markedNoise = verdicts.filter((v) => !v.relevant).length;
      const skipped = new Set([...relevant, ...noise]).size - pending.size;
      const left = listUnclassifiedForReview(jids, 1).length;
      return text(
        `Saved ${saved} verdict(s): ${saved - markedNoise} relevant, ${markedNoise} noise` +
          (protectedCount > 0 ? ` (${protectedCount} kept as relevant for explicit finance content)` : "") +
          (skipped > 0 ? `; ${skipped} rowid(s) ignored (unknown, exempt or already classified)` : "") +
          `. ${left > 0 ? "More messages are pending." : "Nothing left to classify."}`
      );
    }
  );

  // ── Portfolio & market ──────────────────────────────────────────────────────

  server.registerTool(
    "sectors",
    {
      title: "Sector lookup",
      description:
        "Sub-sector for each ticker: the curated sector map first, then TradingView's " +
        "real profile (stock sector/industry; ETF asset class, focus and index tracked) " +
        "for anything outside it. Call this for every discussed ticker not in the " +
        "Portfolio block instead of inferring a sector from the name.",
      inputSchema: {
        tickers: z.array(z.string()).min(1).max(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tickers }) => {
      const classes = await classifyTickers(tickers);
      const mapped = Object.values(classes)
        .filter((c) => c.source === "map")
        .map((c) => `${c.ticker}=${SECTORS[c.sector!].label}`);
      return text(
        (mapped.length ? `Curated map: ${mapped.join(", ")}\n` : "") + renderSectorLookup(classes)
      );
    }
  );

  server.registerTool(
    "portfolio",
    {
      title: "Portfolio",
      description:
        "Current holdings with live prices and MA200 slopes, cash balance and " +
        "recent total-value history. Same rendering the analysis " +
        "prompt gets, so position-sizing rules apply directly.",
      inputSchema: {
        historyDays: z.number().int().min(0).max(365).default(14),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ historyDays }) => {
      const section = await buildPortfolioContext();
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

  // ── main analyst ADD ledger (the only writable surface) ─────────────────────────────

  server.registerTool(
    "main_analyst_adds",
    {
      title: "main analyst ADD ledger",
      description:
        "the main analyst watchlist adds with their lifecycle status (ACTIVE / AGING / EXPIRED / " +
        "INVALIDATED) judged against live price, MA200 slope and each ADD's invalidation level.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await loadMainAnalystAddLedger();
      if (rows.length === 0) return text("No active main analyst ADDs.");
      return text(renderMainAnalystAddLedger(rows));
    }
  );

  server.registerTool(
    "record_main_analyst_add",
    {
      title: "Record a main analyst ADD",
      description:
        "Add (or re-activate) a ticker in the the main analyst ledger so every future analysis " +
        "treats it as a live [★ MAIN ANALYST ADD]. Use this when the main analyst adds a name by voice, " +
        "image or chat rather than a '+TICKER' message. Only for an explicit the main analyst buy " +
        "(a '+TICKER' or words like 'buy', 'compren', 'I'm a buyer' naming the ticker) — a " +
        "chart posted without them is a watchlist item, not an ADD. Idempotent per ticker.",
      inputSchema: {
        ticker: z.string().describe("e.g. NVDA"),
        entryPrice: z.string().optional().describe("e.g. '$182.40'"),
        note: z.string().optional().describe("Why — the thesis in a line."),
        addedOn: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
        invalidation: z
          .number()
          .optional()
          .describe("Price that breaks the thesis, if the main analyst gave one (e.g. 310 for CIEN)."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async ({ ticker, entryPrice, note, addedOn, invalidation }) => {
      recordMainAnalystAdd({ ticker, entryPrice, note, addedOn, invalidation });
      return text(
        `Recorded ${ticker.toUpperCase()}. Active ADDs: ` +
          listActiveMainAnalystAdds().map((a) => a.ticker).join(", ")
      );
    }
  );

  server.registerTool(
    "deactivate_main_analyst_add",
    {
      title: "Close a main analyst ADD",
      description:
        "Deactivate a ticker in the the main analyst ledger when the main analyst issues a SELL, or when the " +
        "ledger shows it INVALIDATED or EXPIRED and the position has been exited. An " +
        "unrealised loss alone is NOT a reason.",
      inputSchema: { ticker: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    async ({ ticker }) => {
      deactivateMainAnalystAdd(ticker);
      const left = listActiveMainAnalystAdds().map((a) => a.ticker);
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
