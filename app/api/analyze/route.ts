import { streamAnalysis } from "@/lib/ai/analyze";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY no está configurada en las variables de entorno." },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();

  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });

  // Run the analysis in the background — errors are forwarded as SSE events
  (async () => {
    try {
      for await (const chunk of streamAnalysis()) {
        if (cancelled) break;
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
    } catch (err) {
      if (!cancelled) {
        const errChunk = { type: "error", error: String(err) };
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      }
    } finally {
      if (!cancelled) ctrl.close();
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
