import { getStatus, getGroups } from "@/lib/whatsapp/client";
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
