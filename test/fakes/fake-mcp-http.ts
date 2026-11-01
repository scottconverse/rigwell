// Fake MCP server over HTTP. mode "json": streamable HTTP with JSON bodies; "sse": streamable HTTP answering
// each POST with an SSE stream; "legacy": old SSE transport (GET stream + POST endpoint).
import { handleMcpRequest } from "./fake-mcp-core.ts";

export function startFakeMcpHttp(mode: "json" | "sse" | "legacy" = "json", opts: { requireHeader?: [string, string] } = {}) {
  const seenHeaders: Record<string, string>[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const enc = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seenHeaders.push(Object.fromEntries(req.headers));
      if (opts.requireHeader && req.headers.get(opts.requireHeader[0]) !== opts.requireHeader[1]) return new Response("nope", { status: 401 });
      if (mode === "legacy") {
        if (req.method === "GET") {
          return new Response(new ReadableStream({
            start(c) { streams.push(c); c.enqueue(enc.encode("event: endpoint\ndata: /messages\n\n")); },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        const msg = await req.json();
        const res = handleMcpRequest(msg);
        if (res) streams[0]?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(res)}\n\n`));
        return new Response("Accepted", { status: 202 });
      }
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      const msg = await req.json();
      const res = handleMcpRequest(msg);
      const h: Record<string, string> = { "mcp-session-id": "sess-1" };
      if (!res) return new Response(null, { status: 202, headers: h });
      if (mode === "sse") {
        return new Response(`event: message\ndata: ${JSON.stringify(res)}\n\n`, { headers: { ...h, "content-type": "text/event-stream" } });
      }
      return Response.json(res, { headers: h });
    },
  });
  return { url: mode === "legacy" ? `http://localhost:${server.port}/sse` : `http://localhost:${server.port}/mcp`, seenHeaders, stop: () => server.stop(true) };
}
