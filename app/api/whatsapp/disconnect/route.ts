import { disconnect } from "@/lib/whatsapp/client";

export async function POST() {
  await disconnect();
  return Response.json({ ok: true });
}
