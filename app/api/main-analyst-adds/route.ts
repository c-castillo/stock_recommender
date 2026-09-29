import {
  listActiveMainAnalystAdds,
  recordMainAnalystAdd,
  deactivateMainAnalystAdd,
} from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

// GET — list active main analyst ADDs (the persisted ledger injected into every run).
export async function GET() {
  return Response.json({ adds: listActiveMainAnalystAdds() });
}

// POST { ticker, entryPrice?, note?, addedOn?, invalidation? } — record/re-activate an ADD.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.ticker || typeof body.ticker !== "string") {
    return Response.json({ error: "ticker requerido" }, { status: 400 });
  }
  recordMainAnalystAdd({
    ticker: body.ticker,
    entryPrice: body.entryPrice ?? null,
    note: body.note ?? null,
    addedOn: body.addedOn ?? null,
    invalidation: typeof body.invalidation === "number" ? body.invalidation : null,
  });
  return Response.json({ adds: listActiveMainAnalystAdds() });
}

// DELETE ?ticker=XYZ — deactivate an ADD (the main analyst SELL / thesis closed).
export async function DELETE(request: Request) {
  const ticker = new URL(request.url).searchParams.get("ticker");
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  deactivateMainAnalystAdd(ticker);
  return Response.json({ adds: listActiveMainAnalystAdds() });
}
