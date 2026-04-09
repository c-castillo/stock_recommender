import { listGroups, setGroupSelected } from "@/lib/whatsapp/db";

export async function GET() {
  return Response.json({ groups: listGroups() });
}

export async function PATCH(request: Request) {
  const body = await request.json();

  if (typeof body.jid !== "string" || typeof body.selected !== "boolean") {
    return Response.json({ error: "jid (string) y selected (boolean) son requeridos" }, { status: 400 });
  }

  setGroupSelected(body.jid, body.selected);
  return Response.json({ ok: true, groups: listGroups() });
}
