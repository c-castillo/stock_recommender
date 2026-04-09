import { connect } from "@/lib/whatsapp/client";

export async function POST() {
  await connect();
  return Response.json({ ok: true });
}
