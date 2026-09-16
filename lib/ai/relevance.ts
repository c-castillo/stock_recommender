/**
 * Stage 0b — model-backed relevance marking (model tiering: Haiku).
 *
 * The deterministic gate in lib/whatsapp/noise.ts refuses to STORE what is
 * empty by construction. This pass handles everything that needs judgement:
 * football results, tennis brackets, restaurant plans and in-jokes that arrive
 * in a group which is otherwise full of real analysis.
 *
 * It MARKS (`wa_messages.relevance = 0`) rather than deletes. That distinction
 * is the whole safety model: a wrong verdict here hides a message from the
 * analyst but leaves it on disk, so it can be re-classified or swept back in.
 * WhatsApp cannot refetch interior history, so nothing a model merely *believes*
 * is noise should ever be destroyed at write time.
 *
 * Only groups listed in PRUNABLE_GROUPS are classified. 👽 Dr. Market 🇺🇸 USA
 * Trading is exempt by design: it is 100% on-topic, so there is nothing to gain
 * and a false positive there would hide genuine signal.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import {
  listGroupJidsByName,
  listUnclassifiedMessages,
  setRelevance,
} from "@/lib/whatsapp/db";
import { PRUNABLE_GROUPS } from "@/lib/whatsapp/analysis-groups";
import { hasExplicitFinanceContent } from "@/lib/whatsapp/noise";

/** Messages per Haiku call. Small enough that one bad batch costs little. */
const BATCH_SIZE = 60;

/** Batches per sweep, so a backlog is worked down over several runs. */
const MAX_BATCHES_PER_SWEEP = 12;

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      i: z.number().describe("The message's index number, exactly as given"),
      relevant: z
        .boolean()
        .describe("true if it could inform a US-equity recommendation"),
    })
  ),
});

const INSTRUCTIONS = `You filter a WhatsApp corpus that feeds a US-equity trading analyst.

For each numbered message decide whether it could inform an investment recommendation.

RELEVANT (true) — err on the side of true when unsure:
- any ticker, company, sector, index, ETF or crypto asset
- prices, levels, targets, stops, technical or fundamental analysis
- macro, rates, the Fed, inflation, FX, commodities, earnings, broker research
- questions, opinions or sentiment about any of the above, even brief or sarcastic
- references to a chart, PDF or report being shared
- anything that gives context to a trading discussion, including replies like
  "I sold half" or "that level held"

NOT RELEVANT (false):
- football/soccer, tennis and other sport not used as market metaphor
- personal plans, meals, travel, family, birthdays, health
- workplace/logistics chatter unrelated to markets
- pure jokes, memes and banter with no market content
- technical support about phones, apps or file systems

Return one verdict per message, using the exact index given. Do not skip any.`;

function renderBatch(rows: { id: string; body: string }[]): string {
  return rows
    .map((r, i) => `${i}: ${r.body.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
}

/**
 * A message carrying an explicit price, percentage, finance term or real ticker
 * is relevant regardless of what the model says.
 *
 * Per-message classification has no conversational context, so short fragments
 * get misread — an audit caught "KRX" (the Korea Exchange) and "en 200 semanas"
 * (a 200-week moving average) marked as noise. The model may promote a message
 * to relevant, never demote one below this floor.
 *
 * Kept high-precision on purpose: an earlier version accepted BARE uppercase
 * tokens as tickers and promoted 143 messages, "GM" (good morning, read as
 * General Motors) among them. Only a $-sigil ticker or explicit finance
 * vocabulary overrides the model.
 */
function isProtected(body: string): boolean {
  return hasExplicitFinanceContent(body);
}

async function classifyBatch(
  rows: { id: string; body: string }[]
): Promise<{ id: string; relevant: boolean }[]> {
  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: verdictSchema,
    maxOutputTokens: 4096,
    messages: [{ role: "user", content: `${INSTRUCTIONS}\n\n${renderBatch(rows)}` }],
  });

  const out: { id: string; relevant: boolean }[] = [];
  for (const v of object.verdicts) {
    const row = rows[v.i];
    if (!row) continue;
    const relevant = v.relevant || isProtected(row.body);
    out.push({ id: row.id, relevant });
  }
  return out;
}

export interface RelevanceSweepResult {
  classified: number;
  markedNoise: number;
  failedBatches: number;
}

/**
 * Classify pending messages in the prunable groups. Fail-safe: a batch that
 * throws leaves its messages NULL (which reads as relevant), so a model or
 * network failure can only ever under-filter, never hide something.
 */
export async function sweepRelevance(
  maxBatches = MAX_BATCHES_PER_SWEEP
): Promise<RelevanceSweepResult> {
  const jids = listGroupJidsByName(PRUNABLE_GROUPS);
  const result: RelevanceSweepResult = { classified: 0, markedNoise: 0, failedBatches: 0 };
  if (jids.length === 0) return result;

  for (let b = 0; b < maxBatches; b++) {
    const rows = listUnclassifiedMessages(jids, BATCH_SIZE);
    if (rows.length === 0) break;

    let verdicts: { id: string; relevant: boolean }[];
    try {
      verdicts = await classifyBatch(rows);
    } catch {
      result.failedBatches++;
      break; // stop the sweep; the rows stay NULL and are retried next run
    }

    // A message the model omitted stays NULL rather than defaulting to noise.
    if (verdicts.length === 0) {
      result.failedBatches++;
      break;
    }

    result.classified += setRelevance(verdicts);
    result.markedNoise += verdicts.filter((v) => !v.relevant).length;
  }

  return result;
}
