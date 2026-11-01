// Local webhook receiver (spec §16.5): POST /hooks/<automationId> on 127.0.0.1. Auth is checked by the manager.
import type { AutomationManager } from "./manager.ts";

export interface WebhookServer { port: number; host: string; stop(): void }

export function startWebhookServer(mgr: AutomationManager, opts: { port?: number; host?: string } = {}): WebhookServer {
  const host = opts.host ?? "127.0.0.1";
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/hooks\/([^/]+)$/.exec(url.pathname);
      if (!m) return json(404, { error: "not found" });
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const cap = mgr.limits.maxBodyBytes;
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > cap) return json(413, { error: "body too large" });
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > cap) return json(413, { error: "body too large" });
      const r = mgr.receiveWebhook(decodeURIComponent(m[1]), new TextDecoder().decode(buf), {
        authorization: req.headers.get("authorization"),
        signature: req.headers.get("x-rigwell-signature"),
      });
      return json(r.httpStatus, r.body);
    },
  });
  return { port: server.port ?? 0, host, stop: () => void server.stop(true) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
