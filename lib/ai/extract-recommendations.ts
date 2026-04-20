import type { AIRecommendation } from "./analyze";

export function extractRecommendations(text: string): AIRecommendation[] {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length === 0) return [];
  try {
    const parsed = JSON.parse(matches[matches.length - 1][1].trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r) => typeof r.ticker === "string" && ["BUY", "SELL", "HOLD"].includes(r.action)
    ) as AIRecommendation[];
  } catch {
    return [];
  }
}
