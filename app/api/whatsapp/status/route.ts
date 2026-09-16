import { getStatus, getGroups, ensureGroups } from "@/lib/whatsapp/client";
import { countMessages } from "@/lib/whatsapp/db";
import QRCode from "qrcode";

export async function GET() {
  const { status, qr, error } = getStatus();

  let qrDataUrl: string | null = null;
  if (qr) {
    try {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
    } catch {
      // ignore
    }
  }

  // Self-heal: if we're connected but have no groups cached (the initial
  // `ready` refresh raced ahead of the chat store), re-fetch before responding.
  if (status === "connected") await ensureGroups();

  const groups = status === "connected" ? getGroups() : [];
  const totalMessages = status === "connected" ? countMessages() : 0;

  return Response.json({
    status,
    qrDataUrl,
    error,
    groups,
    totalMessages,
  });
}
