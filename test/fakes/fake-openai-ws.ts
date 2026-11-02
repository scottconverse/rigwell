// Scripted fake OpenAI Responses server with a WebSocket endpoint (response.create frames) and an HTTP SSE endpoint
// for the fallback. Both serve any path, so the base URL of the model decides nothing.
import { openaiEvents } from "./fake-openai.ts";
import { sse, type FakeServer, type FakeTurn, type FakeTurnSpec } from "./types.ts";
export type { FakeTurn } from "./types.ts";

export type FakeWsTurnSpec = FakeTurnSpec & {
  /** Send an `error` frame (as the API does for a rejected request) instead of a response. */
  wsError?: { status: number; code?: string; message: string };
  /** Close the socket with this code instead of answering. */
  closeWith?: number;
  /** Send the first half of the events, then close the socket abnormally. */
  dropMidStream?: boolean;
  /** Never answer. */
  silent?: boolean;
  /** Wait before the first event (ping tests). */
  delayMs?: number;
};

export interface FakeWsOptions {
  /** Answer this many upgrade attempts with HTTP 500 before accepting one. */
  rejectUpgrades?: number;
  /** Wait this long before accepting an upgrade (connect timeout tests). */
  connectDelayMs?: number;
  /** Script for the HTTP endpoint (fallback). */
  httpScript?: FakeTurn[];
}

export interface FakeWsServer extends FakeServer {
  /** The response.create frames received, in order (same as `requests`). */
  frames: any[];
  httpRequests: any[];
  upgrades: number;
  pings: number;
  closes: { code: number }[];
  /** Number of sockets that are open now. */
  open(): number;
}

export async function startFakeOpenAIWs(script: FakeTurn[], opts: FakeWsOptions = {}): Promise<FakeWsServer> {
  const frames: any[] = [];
  const headers: Record<string, string>[] = [];
  const httpRequests: any[] = [];
  const state = { upgrades: 0, pings: 0, closes: [] as { code: number }[], open: 0, rejected: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        state.upgrades++;
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => (h[k] = v));
        headers.push(h);
        if (opts.connectDelayMs) await Bun.sleep(opts.connectDelayMs);
        if (state.rejected < (opts.rejectUpgrades ?? 0)) { state.rejected++; return new Response("no", { status: 500 }); }
        return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      // HTTP fallback
      const body = await req.json().catch(() => ({}));
      const idx = httpRequests.length;
      httpRequests.push(body);
      const entry = opts.httpScript?.[idx];
      if (!entry) return new Response(JSON.stringify({ error: { message: "fake: http script exhausted" } }), { status: 500 });
      const turn = typeof entry === "function" ? entry(body, idx) : entry;
      const evs = openaiEvents(turn, 1000 + idx).map((e) => sse(e.type, e)).join("");
      return new Response(evs, { headers: { "content-type": "text/event-stream" } });
    },
    websocket: {
      open() { state.open++; },
      ping() { state.pings++; },
      close(_ws, code) { state.open--; state.closes.push({ code }); },
      async message(ws, raw) {
        const frame = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
        const idx = frames.length;
        frames.push(frame);
        const entry = script[idx];
        if (!entry) {
          ws.send(JSON.stringify({ type: "error", status: 500, error: { code: "server_error", message: "fake server: script exhausted" } }));
          return;
        }
        const turn = (typeof entry === "function" ? entry(frame, idx) : entry) as FakeWsTurnSpec;
        if (turn.silent) return;
        if (turn.closeWith !== undefined) { ws.close(turn.closeWith, "fake close"); return; }
        if (turn.wsError) {
          ws.send(JSON.stringify({ type: "error", status: turn.wsError.status, error: { code: turn.wsError.code, message: turn.wsError.message } }));
          return;
        }
        if (turn.delayMs) await Bun.sleep(turn.delayMs);
        let evs = openaiEvents(turn, idx);
        if (turn.dropMidStream) evs = evs.slice(0, Math.max(2, Math.ceil(evs.length / 2)));
        for (const e of evs) { ws.send(JSON.stringify(e)); await Bun.sleep(0); }
        if (turn.dropMidStream) ws.terminate();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`, requests: frames, frames, headers, httpRequests,
    get upgrades() { return state.upgrades; }, get pings() { return state.pings; }, closes: state.closes,
    open: () => state.open,
    stop: () => void server.stop(true),
  };
}
