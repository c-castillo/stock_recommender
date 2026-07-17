import { resetSession } from "@/lib/whatsapp/client";

export async function POST() {
  await resetSession();
  return Response.json({ ok: true });
}
