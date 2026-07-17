/**
 * #3 — structured recommendation extraction (model tiering: Haiku).
 *
 * Replaces the old brittle ```json-block regex. The synthesis narrative no
 * longer needs to emit JSON at all; this runs a cheap Haiku generateObject
 * pass over the finished report to produce a schema-valid recommendation array.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { AIRecommendation } from "./analyze";

const recommendationSchema = z.object({
  recommendations: z.array(
    z.object({
      ticker: z.string(),
      company: z.string(),
      action: z.enum(["BUY", "SELL", "HOLD"]),
      confidence: z.number().describe("0-100"),
      entryPrice: z.string().nullable(),
      priceTarget: z.string().nullable(),
      stopLoss: z.string().nullable(),
      reasoning: z.string(),
      mentions: z.number().describe("How many times the ticker was mentioned"),
      sources: z.array(z.string()),
    })
  ),
});

/**
 * Extracts the structured recommendations stated in an analysis narrative.
 * Returns [] on any failure so a parsing hiccup never breaks the response.
 */
export async function recommendationsFromNarrative(
  narrative: string
): Promise<AIRecommendation[]> {
  if (!narrative.trim()) return [];
  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: recommendationSchema,
      maxOutputTokens: 8192,
      messages: [
        {
          role: "user",
          content:
            "Extract every actionable stock recommendation stated in this " +
            "investment report as structured data. Use exactly the ticker, " +
            "action, confidence, entry/target/stop, and reasoning given in the " +
            "report — do not invent or infer beyond it.\n\n" +
            narrative,
        },
      ],
    });
    return object.recommendations as AIRecommendation[];
  } catch {
    return [];
  }
}
