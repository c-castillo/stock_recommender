import {
  loadAiRecommendations,
  saveAiRecommendations,
  getAnalysisCache,
  setAnalysisCache,
} from "@/lib/whatsapp/db";
import { updateWikiEntry } from "@/lib/ai/wiki";

export const dynamic = "force-dynamic";

/** Local date, not UTC: an evening run in Chile is already "tomorrow" in UTC. */
function localDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

export async function GET() {
  const recs = loadAiRecommendations();
  const cached = getAnalysisCache();
  return Response.json({
    recommendations: recs,
    generatedAt: recs[0]?.generatedAt ?? null,
    narrative: cached?.narrative || null,
    narrativeAt: cached?.createdAt ?? null,
  });
}

/**
 * Replaces the stored recommendations.
 *
 * With a `narrative` (the /daily-run publish step) it also does what the in-app
 * pipeline does after its own synthesis: stores the report so the dashboard can
 * show it, and appends each verdict to the per-ticker wiki so the next run's
 * "prior verdicts" block is current. Without one (the dashboard echoing back
 * recommendations it just streamed) only the table is replaced — that run has
 * already written its own cache and wiki entries.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.recommendations)) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  saveAiRecommendations(body.recommendations);

  let wikiUpdated = 0;
  const narrative = typeof body.narrative === "string" ? body.narrative.trim() : "";
  if (narrative) {
    const date =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : localDate();
    // The hash never matches a real inputs hash, so the dashboard's Analyze
    // button still runs fresh instead of replaying this report as its own.
    setAnalysisCache({
      hash: `daily-run:${date}`,
      createdAt: Date.now(),
      narrative,
      recommendations: body.recommendations,
      stats: null,
    });
    for (const rec of body.recommendations) {
      try {
        updateWikiEntry(rec, date);
        wikiUpdated++;
      } catch {
        // Non-fatal: one bad row must not lose the rest.
      }
    }
  }

  return Response.json({ saved: body.recommendations.length, narrative: Boolean(narrative), wikiUpdated });
}
