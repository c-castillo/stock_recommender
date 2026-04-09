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

  // We need a controller reference that's reachable from the async runner
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });

  // Run the analysis in the background — errors are forwarded as SSE events
  (async () => {
    try {
      for await (const chunk of streamAnalysis()) {
        const line = `data: ${JSON.stringify(chunk)}\n\n`;
        ctrl.enqueue(encoder.encode(line));
      }
    } catch (err) {
      const errChunk = { type: "error", error: String(err) };
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
    } finally {
      ctrl.close();
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
