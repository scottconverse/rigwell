// Local webhook receiver (spec §16.5): POST /hooks/<automationId> on 127.0.0.1. Auth is checked by the manager.
import type { AutomationManager } from "./manager.ts";
import type { Automation } from "./store.ts";

export interface WebhookServer { port: number; host: string; stop(): void }

export function startWebhookServer(mgr: AutomationManager, opts: { port?: number; host?: string; external?: (a: Automation, body: string, headers: { signature?: string | null; event?: string | null; delivery?: string | null }) => { httpStatus: number; body: Record<string, unknown> } } = {}): WebhookServer {
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
      const reader = req.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > cap) return json(413, { error: "body too large" }); chunks.push(part.value); } }
      finally { await reader?.cancel().catch(() => {}); }
      let id: string; try { id = decodeURIComponent(m[1]); } catch { return json(400, { error: "invalid path" }); }
      const raw = Buffer.concat(chunks).toString("utf8"), automation = mgr.list().find((a) => a.id === id && a.isValid);
      if (automation && ["github", "ci"].includes(automation.fm.trigger!) && opts.external) {
        const r = opts.external(automation, raw, { signature: req.headers.get("x-hub-signature-256"), event: req.headers.get("x-github-event"), delivery: req.headers.get("x-github-delivery") }); return json(r.httpStatus, r.body);
      }
      const r = mgr.receiveWebhook(id, raw, {
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
