import { loadAiRecommendations, saveAiRecommendations } from "@/lib/whatsapp/db";

export async function GET() {
  const recs = loadAiRecommendations();
  return Response.json({ recommendations: recs, generatedAt: recs[0]?.generatedAt ?? null });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.recommendations)) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  saveAiRecommendations(body.recommendations);
  return Response.json({ saved: body.recommendations.length });
}
