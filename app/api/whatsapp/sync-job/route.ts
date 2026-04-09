import {
  startSyncJob,
  getActiveSyncJob,
} from "@/lib/whatsapp/sync-jobs";

export async function POST(request: Request) {
  const body = await request.json();
  const groups: { jid: string; name: string }[] = body.groups;

  if (!Array.isArray(groups) || groups.length === 0) {
    return Response.json(
      { error: "Selecciona al menos un grupo" },
      { status: 400 }
    );
  }

  try {
    const job = await startSyncJob(groups);
    return Response.json({ job });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
}

export async function GET() {
  const job = getActiveSyncJob();
  return Response.json({ job });
}
