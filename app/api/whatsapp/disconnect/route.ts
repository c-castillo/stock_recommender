import { disconnect } from "@/lib/whatsapp/client";

export async function POST() {
  disconnect();
  return Response.json({ ok: true });
}
