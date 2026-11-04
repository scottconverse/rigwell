// Loopback CDP proxy for the browser pane (spec §17.3). The pane's tabs are Electron <webview> elements; the daemon's
// Browser tool speaks the Chrome DevTools Protocol to a "browser" endpoint. This module makes the set of registered
// tabs look like one browser: it answers the Target.* commands itself and forwards everything else to the tab named
// by the CDP sessionId (in Electron: webContents.debugger).
//
// The endpoint is ws://127.0.0.1:<port>/devtools/browser/<id> where <id> is a random capability, so other local
// programs that do not know it cannot attach. Only that one path is served.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/** One browser tab as the proxy sees it. In the app this wraps a webContents; tests wrap a headless browser page. */
export interface PaneTarget {
  id: string;
  url(): string;
  title(): string;
  attach(): void;
  detach(): void;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Subscribes to protocol events from the tab. Returns an unsubscribe function. */
  onEvent(cb: (method: string, params: unknown) => void): () => void;
}

export interface PaneHost {
  targets(): PaneTarget[];
  createTab(url: string): Promise<PaneTarget>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): void;
}

export interface CdpProxy { port: number; url: string; browserId: string; stop(): Promise<void> }

export async function startCdpProxy(opts: { host: PaneHost; port?: number; browserId?: string; log?: (m: string) => void }): Promise<CdpProxy> {
  const browserId = opts.browserId ?? randomUUID();
  const path = `/devtools/browser/${browserId}`;
  const http: Server = createServer((req, res) => {
    // Chromium-style discovery, answered only for the capability path's parent being known.
    if (req.url === "/json/version" && req.headers.host?.startsWith("127.0.0.1")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "Rigwell/Pane", "Protocol-Version": "1.3" }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== path || !/^127\.0\.0\.1(:\d+)?$/.test(req.headers.host ?? "")) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket) {
    const attached = new Map<string, { target: PaneTarget; off: () => void }>(); // sessionId -> target
    const reply = (id: number, result: unknown, sessionId?: string) => ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
    const fail = (id: number, message: string, sessionId?: string) => ws.send(JSON.stringify({ id, error: { code: -32000, message }, ...(sessionId ? { sessionId } : {}) }));
    const info = (t: PaneTarget) => ({ targetId: t.id, type: "page", title: t.title(), url: t.url(), attached: [...attached.values()].some((a) => a.target === t), canAccessOpener: false });

    ws.on("message", async (raw) => {
      let m: { id: number; method: string; params?: Record<string, any>; sessionId?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const params = m.params ?? {};
      try {
        if (m.sessionId) {
          const a = attached.get(m.sessionId);
          if (!a) return fail(m.id, "No session with given id", m.sessionId);
          return reply(m.id, (await a.target.send(m.method, params)) ?? {}, m.sessionId);
        }
        switch (m.method) {
          case "Target.getTargets": return reply(m.id, { targetInfos: opts.host.targets().map(info) });
          case "Target.attachToTarget": {
            const t = opts.host.targets().find((x) => x.id === params.targetId);
            if (!t) return fail(m.id, "No target with given id");
            const sessionId = `pane-${t.id}-${randomUUID().slice(0, 8)}`;
            t.attach();
            const off = t.onEvent((method, p) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ method, params: p, sessionId })));
            attached.set(sessionId, { target: t, off });
            return reply(m.id, { sessionId });
          }
          case "Target.createTarget": {
            const t = await opts.host.createTab(String(params.url ?? "about:blank"));
            return reply(m.id, { targetId: t.id });
          }
          case "Target.closeTarget": await opts.host.closeTab(String(params.targetId)); return reply(m.id, { success: true });
          case "Target.activateTarget": opts.host.activateTab(String(params.targetId)); return reply(m.id, {});
          case "Browser.getVersion": return reply(m.id, { protocolVersion: "1.3", product: "Rigwell/Pane", userAgent: "Rigwell", jsVersion: "" });
          default: return fail(m.id, `'${m.method}' wasn't found`);
        }
      } catch (e) {
        fail(m.id, (e as Error).message, m.sessionId);
      }
    });
    ws.on("close", () => { for (const a of attached.values()) { a.off(); try { a.target.detach(); } catch {} } attached.clear(); });
  }

  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(opts.port ?? 0, "127.0.0.1", () => resolve()); });
  const port = (http.address() as { port: number }).port;
  return {
    port, browserId, url: `ws://127.0.0.1:${port}${path}`,
    stop: () => new Promise<void>((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => resolve()); http.closeAllConnections?.(); }),
  };
}
