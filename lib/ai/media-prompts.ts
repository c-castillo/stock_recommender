/**
 * What a media digest is and how to produce one — shared by the API pipeline
 * (media-digest.ts, Haiku/Sonnet on API credits) and the MCP server, where the
 * Claude Code analyst reads the images itself on the user's plan. Kept free of
 * the AI SDK so the MCP server can import it.
 */

import { z } from "zod";

export const digestSchema = z.object({
  ticker: z
    .string()
    .nullable()
    .describe("Primary US-equity ticker the chart/report is about, or null"),
  signal: z
    .enum(["bullish", "bearish", "neutral", "unknown"])
    .describe("Overall directional read of the chart/report"),
  levels: z
    .string()
    .describe("Key prices/levels: support, resistance, target, stop — or '—'"),
  source: z
    .string()
    .describe("What this is: chart screenshot, PDF research report, broker note, etc."),
  summary: z
    .string()
    .describe("One or two dense sentences capturing the actionable content"),
  // Dr CS trades DeMark, and the counts were being thrown away: a chart could
  // be digested as "bullish, support 115.84" while carrying an unreported Sell
  // 13 on its face. The playbook names DeMark explicitly, so the counts are
  // first-class digest output, not part of the prose summary.
  demark: z
    .string()
    .describe(
      "DeMark TD Sequential counts visible on the chart, or '—' if none. " +
        "Record every 9 and 13 with its side: numbers BELOW the bars are Buy " +
        "Setup/Countdown (bullish exhaustion of a downtrend), numbers ABOVE " +
        "are Sell (bearish). Note a perfection arrow/dot, a '+' (deferred 13), " +
        "an 'R' (recycle), counts still extending past 9, and any TDST or risk " +
        "level lines. Example: 'Sell Countdown 13 above bars, perfected; TDST " +
        "support 318'."
    ),
  // Fibonacci is the playbook's PRIMARY setup ("Fibonacci main, Demark
  // secondary"), so its levels — and above all where the grid is anchored —
  // belong in the digest rather than being lost in the prose summary.
  fibonacci: z
    .string()
    .describe(
      "Fibonacci levels drawn on the chart, or '—' if none. Give the ANCHORS " +
        "first (which swing high and low the grid is drawn from, and whether " +
        "they are cycle extremes or secondary pivots), then the plotted levels " +
        "with prices (0.236/0.382/0.5/0.618/0.786, extensions 1.618/2.618/" +
        "4.236), then which levels price actually reacted at. Note fans, arcs " +
        "or time zones if present, and whether the scale is log or arithmetic. " +
        "Example: 'Retracement anchored 2023 high 62.40 → 2025 low 28.10; " +
        "0.382=41.2, 0.5=45.2, 0.618=49.3; rejected twice at 0.382'."
    ),
  // Routes the image to verbatim transcription. The digest compresses an
  // image to one or two sentences, which is right for a chart but threw away
  // most of a tweet, a news screenshot or a broker table.
  text_heavy: z
    .boolean()
    .describe(
      "true when the image's information is mostly TEXT or NUMBERS rather than a " +
        "price chart: screenshots of tweets/X posts, news headlines or articles, " +
        "chat messages, broker notes, tables, screeners/watchlists, earnings " +
        "calendars, P&L or portfolio screens. false for price charts (even " +
        "annotated ones), photos and memes."
    ),
});

export type MediaDigest = z.infer<typeof digestSchema> & { transcript?: string };

export const PROMPT =
  "You are digesting a single piece of media shared in a stock-trading WhatsApp " +
  "group. Extract only what matters for an investment decision: the ticker, the " +
  "directional signal, key price levels, the source type, and a dense one/two-line " +
  "summary. If it is not finance-related, set signal='unknown' and say so in summary.\n\n" +
  "ALWAYS check the chart for DeMark TD Sequential counts and fill the `demark` " +
  "field. These are small numbers printed against the price bars (Bloomberg and " +
  "Symbolik render the buy side green below the bars and the sell side red above; " +
  "TradingView uses blue for both, so judge by POSITION, not colour). 9 and 13 are " +
  "the counts that matter. A count BELOW the bars is a Buy Setup/Countdown and is " +
  "BULLISH — it marks a downtrend exhausting. A count ABOVE the bars is a Sell " +
  "Setup/Countdown and is BEARISH. Do not invert this. Also record: an arrow or dot " +
  "marking a perfected setup, a '+' (a deferred 13, NOT a 13), an 'R' (recycled, " +
  "the prior 13 is void), counts still running past 9 (the trend has not flipped), " +
  "and any TDST support/resistance or risk-level lines. If the chart has no DeMark " +
  "counts, set demark='—'. Never leave it blank and never guess at an unreadable " +
  "number — say which part was unreadable instead.\n\n" +
  "ALWAYS also check for Fibonacci levels and fill the `fibonacci` field. Look " +
  "for a ladder of horizontal lines labelled with ratios (0.236, 0.382, 0.5, " +
  "0.618, 0.786) or extensions (1.618, 2.618, 4.236), and for fans, arcs or " +
  "vertical time zones. Report the ANCHORS FIRST — which swing high and swing " +
  "low the grid is drawn between, and whether those are the cycle extremes or " +
  "secondary pivots — because every level depends on that choice. Then give the " +
  "levels with their prices, and say which ones price actually reacted at. Note " +
  "whether the scale is logarithmic or arithmetic. If there are no Fibonacci " +
  "levels, set fibonacci='—'.\n\n" +
  "In `summary`, when the image is a price chart, lead with the technical frame " +
  "the levels sit in: the timeframe (daily/weekly/monthly), the trend by peaks " +
  "and troughs (uptrend = higher peaks AND higher troughs; downtrend = lower " +
  "peaks AND lower troughs; otherwise sideways), price versus its moving " +
  "averages and whether those averages are themselves rising or falling, and any " +
  "momentum divergence (price at a new extreme that the oscillator does not " +
  "confirm). Name reversal patterns such as head and shoulders with their " +
  "neckline. Do not use 'Stage 1-4' labels — this framework's phases are up, " +
  "advancing, down and terminating, defined by whether momentum is rising or " +
  "falling and above or below zero.";

export const STUDIES_PROMPT =
  "Read ONLY the DeMark TD Sequential counts on this chart. Numbers BELOW the " +
  "bars are Buy Setup/Countdown (bullish); numbers ABOVE the bars are Sell " +
  "Setup/Countdown (bearish). Bloomberg/Symbolik render buy green below and sell " +
  "red above; TradingView uses blue for both — judge by POSITION, not colour. " +
  "Report BOTH sides: it is a common and costly error to notice one side only. " +
  "Record every 9 and 13 with its side and approximate date, any perfection " +
  "arrow or dot, any '+' (deferred 13, not a 13), any 'R' (recycle, prior 13 " +
  "void), counts still running past 9 (trend has not flipped), and TDST or risk " +
  "level lines with their prices. If digits are crowded or unreadable, say so " +
  "explicitly rather than guessing. Set demark='—' if the chart has no counts.\n\n" +
  "Then read the FIBONACCI levels into `fibonacci`. Report the ANCHORS FIRST — " +
  "which swing high and swing low the grid is drawn between, and whether those " +
  "are the cycle extremes or secondary/interior pivots — because every level " +
  "depends on that choice. Then list the plotted ratios with their prices " +
  "(0.236/0.382/0.5/0.618/0.786; extensions 1.618/2.618/4.236), and say which " +
  "levels price actually reacted at (bounces, rejections, consolidation sitting " +
  "on a line). Note fans, arcs or vertical time zones, and whether the scale is " +
  "logarithmic or arithmetic. Set fibonacci='—' if there are none.\n\n" +
  "BE TERSE. Each field is at most about 400 characters — roughly three clauses: " +
  "anchors, levels, reaction. This is an index entry, not an essay. Do not " +
  "speculate about anchors that are off-screen or not visible; write 'anchors " +
  "not visible' and move on. Do not list moving averages, oscillator readings or " +
  "other overlays that are not part of the study.";

// Adapted from the transcribing-images skill's page prompt, narrowed to what
// WhatsApp screenshots carry.
export const TRANSCRIBE_PROMPT =
  "Transcribe this image as a human reader would read it, keeping everything a " +
  "trader could use and nothing else.\n\n" +
  "KEEP, verbatim and complete: headlines, body text, author names and handles, " +
  "dates and timestamps, captions, footnotes that carry data or sources, and every " +
  "table, screener or watchlist — in reading order and in the ORIGINAL language " +
  "(do not translate). Render tables as markdown, one row per line, keeping every " +
  "number and sign exactly as shown (%, $, +/-, K/M/B). For a tweet or post, give " +
  "the author and handle, then the text, then any quoted post. For a chat " +
  "screenshot, give each message as 'Sender: text'. If a chart is embedded, name " +
  "it in one line and transcribe the text around it.\n\n" +
  "DROP whole blocks that carry no market content: phone and app UI (status bar, " +
  "battery, keyboards, navigation, buttons and icons such as Share/Bookmark/PDF, " +
  "like/retweet/view counters), ads and promos, cookie or subscribe banners, " +
  "legal disclaimers and boilerplate, 'related articles' lists, and unrelated " +
  "sidebar content. When unsure whether something matters, keep it.\n\n" +
  "Never paraphrase or shorten what you keep — dropping is the only edit allowed. " +
  "Mark an unreadable fragment as [illegible] rather than guessing. No commentary. " +
  "Output plain markdown only.";
