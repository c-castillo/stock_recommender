import { getStatus, refreshGroups } from "@/lib/whatsapp/client";
import { listGroups, countMessages } from "@/lib/whatsapp/db";

export async function POST() {
  const { status } = getStatus();

  if (status !== "connected") {
    return Response.json(
      { error: "WhatsApp no está conectado. Conecta primero desde el panel." },
      { status: 400 }
    );
  }

  // Re-fetch group list from WhatsApp
  await refreshGroups();

  const groups = listGroups().map((g) => ({
    jid: g.jid,
    name: g.name,
    messages: countMessages(g.jid),
    syncedAt: g.synced_at,
  }));

  return Response.json({
    success: true,
    syncedAt: new Date().toISOString(),
    groups,
    totalMessages: countMessages(),
  });
}
