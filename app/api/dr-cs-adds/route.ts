import {
  listActiveDrCsAdds,
  recordDrCsAdd,
  deactivateDrCsAdd,
} from "@/lib/whatsapp/db";

export const dynamic = "force-dynamic";

// GET — list active Dr CS ADDs (the persisted ledger injected into every run).
export async function GET() {
  return Response.json({ adds: listActiveDrCsAdds() });
}

// POST { ticker, entryPrice?, note?, addedOn? } — record/re-activate an ADD.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.ticker || typeof body.ticker !== "string") {
    return Response.json({ error: "ticker requerido" }, { status: 400 });
  }
  recordDrCsAdd({
    ticker: body.ticker,
    entryPrice: body.entryPrice ?? null,
    note: body.note ?? null,
    addedOn: body.addedOn ?? null,
  });
  return Response.json({ adds: listActiveDrCsAdds() });
}

// DELETE ?ticker=XYZ — deactivate an ADD (Dr CS SELL / thesis closed).
export async function DELETE(request: Request) {
  const ticker = new URL(request.url).searchParams.get("ticker");
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });
  deactivateDrCsAdd(ticker);
  return Response.json({ adds: listActiveDrCsAdds() });
}
