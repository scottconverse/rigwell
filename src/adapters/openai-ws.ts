// OpenAI Responses over WebSocket (spec 4.6.3): `response.create` frames, chaining with previous_response_id,
// timers, and the fallbacks to HTTP. One connection per session, kept between turns.
import { ModelError, type ModelConfig, type ModelRequest } from "../core/types.ts";

export interface WsOptions {
  /** auto: only when the custom-model conditions of 4.6.3 hold; off: never; force: skip the base URL check (tests, own gateways). Default from RIGWELL_OPENAI_WEBSOCKET. */
  mode?: "auto" | "off" | "force";
  /** The endpoint is Azure OpenAI: also fall back on 400 model_not_found and the 403 "different inference provider" message. */
  azure?: boolean;
  connectTimeoutMs?: number; // 15 s
  pingIntervalMs?: number;   // 30 s, during a turn
  idleCloseMs?: number;      // 180 s
}

export const WS_DEFAULTS = { connectTimeoutMs: 15_000, pingIntervalMs: 30_000, idleCloseMs: 180_000 } as const;
export const OPENAI_PUBLIC_BASE = "https://api.openai.com/v1";

/** A transport problem, as opposed to an error the server reported. The adapter turns it into an HTTP retry when nothing was streamed yet. */
export class WsFallback extends Error {
  constructor(public detail: string) { super(detail); }
  toModelError(): ModelError {
    return new ModelError("network", `WebSocket transport failed: ${this.detail}`, { retryable: true });
  }
}

interface Conn {
  ws: WebSocket;
  queue: any[];
  wake?: () => void;
  closed: boolean;
  closeCode?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface Chain { model: string; input: string[]; assistant: string[]; responseId: string }

export interface WsSessionState {
  failures: number;
  disabled: boolean;
  disabledReason?: string;
  conn?: Conn;
  chain?: Chain;
  /** How the last turn was sent. */
  lastMode?: "ws_chained" | "ws_full";
  connects: number;
}

const states = new Map<string, WsSessionState>();

export function wsSessionState(sessionId: string): WsSessionState {
  let s = states.get(sessionId);
  if (!s) { s = { failures: 0, disabled: false, connects: 0 }; states.set(sessionId, s); }
  return s;
}

/** Closes the session's socket and forgets its state (call when a session ends). */
export function closeOpenAIWs(sessionId?: string): void {
  for (const [id, s] of states) {
    if (sessionId !== undefined && id !== sessionId) continue;
    dropConn(s);
    if (sessionId !== undefined) states.delete(id);
  }
  if (sessionId === undefined) states.clear();
}

function dropConn(s: WsSessionState): void {
  s.chain = undefined;
  const c = s.conn;
  s.conn = undefined;
  if (!c) return;
  if (c.idleTimer) clearTimeout(c.idleTimer);
  c.closed = true;
  try { c.ws.close(1000); } catch { /* already closed */ }
}

function modeOf(opts: WsOptions): "auto" | "off" | "force" {
  if (opts.mode) return opts.mode;
  const e = (process.env.RIGWELL_OPENAI_WEBSOCKET ?? "").toLowerCase();
  return e === "off" || e === "0" || e === "false" ? "off" : e === "force" ? "force" : "auto";
}

/** Spec 4.6.3: provider openai, OpenAI's public base URL exactly, a plain apiKey, no Bedrock, and not turned off for the session. */
export function wsEligible(m: ModelConfig, opts: WsOptions = {}, sessionId?: string): boolean {
  const mode = modeOf(opts);
  if (mode === "off" || m.provider !== "openai" || m.bedrock) return false;
  if (sessionId !== undefined && states.get(sessionId)?.disabled) return false;
  if (mode === "force") return true;
  return m.baseUrl.replace(/\/+$/, "") === OPENAI_PUBLIC_BASE && !!m.apiKey && !m.extraHeaders?.authorization;
}

/** `<base>/responses` with http -> ws and https -> wss. */
export function wsUrl(httpUrl: string): string {
  return httpUrl.replace(/^https/i, "wss").replace(/^http/i, "ws");
}

function connect(url: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<Conn> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    const h = { ...headers };
    delete h["content-type"];
    try { ws = new (WebSocket as any)(url, { headers: h }) as WebSocket; } catch (e) { return reject(new WsFallback(`connect: ${(e as Error).message}`)); }
    const conn: Conn = { ws, queue: [], closed: false };
    let settled = false;
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(new WsFallback(why));
    };
    const timer = setTimeout(() => fail(`connect timed out after ${timeoutMs} ms`), timeoutMs);
    signal?.addEventListener("abort", () => fail("aborted"), { once: true });
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      (ws as any).unref?.(); // an idle socket must not keep the process alive
      resolve(conn);
    });
    ws.addEventListener("message", (ev) => {
      let data: any;
      try { data = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)); } catch { return; }
      conn.queue.push(data);
      conn.wake?.();
    });
    ws.addEventListener("error", () => { fail("connection error"); });
    ws.addEventListener("close", (ev) => {
      conn.closed = true;
      conn.closeCode = ev.code;
      if (!settled) fail(`closed during connect (code ${ev.code})`);
      conn.wake?.();
    });
  });
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

function transportFailed(s: WsSessionState, why: string, immediate = false): WsFallback {
  s.failures++;
  dropConn(s);
  if (immediate || s.failures >= 2) { s.disabled = true; s.disabledReason = why; }
  return new WsFallback(why);
}

function safeHost(u: string): string { try { return new URL(u).hostname; } catch { return ""; } }

/**
 * Runs one turn over the socket and yields the parsed server events. Throws WsFallback for transport trouble.
 * `onMode` tells the caller whether the turn went out chained or in full.
 */
export async function* openaiWs(
  req: ModelRequest,
  httpUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: WsOptions,
  hardLimitMs: number,
  onMode: (t: { mode: "ws_chained" | "ws_full" }) => void,
): AsyncGenerator<any> {
  const s = wsSessionState(req.sessionId);
  const connectMs = opts.connectTimeoutMs ?? WS_DEFAULTS.connectTimeoutMs;
  const pingMs = opts.pingIntervalMs ?? WS_DEFAULTS.pingIntervalMs;
  const idleCloseMs = opts.idleCloseMs ?? WS_DEFAULTS.idleCloseMs;
  const azure = opts.azure ?? /\.openai\.azure\.com$/i.test(safeHost(httpUrl));

  let conn = s.conn && !s.conn.closed ? s.conn : undefined;
  if (!conn) {
    s.chain = undefined;
    try { conn = await connect(wsUrl(httpUrl), headers, connectMs, req.signal); }
    catch (e) {
      if (req.signal?.aborted) throw new ModelError("unknown", "Request aborted", { retryable: false });
      throw transportFailed(s, e instanceof WsFallback ? e.detail : String(e));
    }
    s.conn = conn;
    s.connects++;
  }
  if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = undefined; }
  conn.queue.length = 0;

  // Chaining: the new input must start with the previous turn's full context (input + what the model answered).
  const fullInput = (body.input as unknown[]) ?? [];
  const strs = fullInput.map((i) => JSON.stringify(i));
  const ch = s.chain;
  let frame: Record<string, unknown> = body;
  let mode: "ws_chained" | "ws_full" = "ws_full";
  if (ch && ch.model === String(body.model)) {
    const ctx = [...ch.input, ...ch.assistant];
    if (strs.length >= ctx.length && ctx.every((x, i) => strs[i] === x)) {
      frame = { ...body, input: fullInput.slice(ctx.length), previous_response_id: ch.responseId };
      mode = "ws_chained";
    }
  }
  s.chain = undefined; // set again by wsReport when this turn completes
  s.lastMode = mode;
  onMode({ mode });
  conn.ws.send(JSON.stringify({ type: "response.create", ...frame }));

  const started = Date.now();
  const abort = () => { dropConn(s); conn!.wake?.(); };
  req.signal?.addEventListener("abort", abort, { once: true });
  const ping = setInterval(() => { try { (conn!.ws as any).ping?.(); } catch { /* ignore */ } }, pingMs);
  let done = false;
  try {
    while (true) {
      while (conn.queue.length === 0) {
        if (req.signal?.aborted) throw new ModelError("unknown", "Request aborted", { retryable: false });
        if (conn.closed) {
          if (conn.closeCode === 1009) throw transportFailed(s, "close code 1009 (message too big)", true);
          throw transportFailed(s, `socket closed before the response finished (code ${conn.closeCode ?? "?"})`);
        }
        const left = hardLimitMs - (Date.now() - started);
        const idle = req.limits?.idleTimeoutMs;
        const wait = Math.max(1, Math.min(left, idle ?? left));
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => { conn!.wake = undefined; resolve(true); }, wait);
          conn!.wake = () => { clearTimeout(t); conn!.wake = undefined; resolve(false); };
        });
        if (timedOut && conn.queue.length === 0 && !conn.closed) {
          dropConn(s);
          const hard = Date.now() - started >= hardLimitMs;
          throw new ModelError("timeout", hard ? `Response ran past the time limit (${hardLimitMs} ms)` : `Stream idle: no data for ${idle} ms`,
            { retryable: true, cause: hard ? "hard_limit" : "idle", elapsedMs: Date.now() - started, limitMs: hard ? hardLimitMs : idle });
        }
      }
      const ev = conn.queue.shift();
      if (ev?.type === "error") {
        const status = ev.status ?? ev.status_code ?? ev.error?.status;
        const code = ev.error?.code ?? ev.code;
        const msg = String(ev.error?.message ?? ev.message ?? "");
        if (azure && ((status === 400 && code === "model_not_found") || (status === 403 && /different inference provider/i.test(msg)))) {
          s.disabled = true;
          s.disabledReason = `azure: ${status} ${code ?? msg}`;
          dropConn(s);
          throw new WsFallback(s.disabledReason);
        }
      }
      if (ev?.type === "response.failed" || ev?.type === "error") s.chain = undefined;
      if (TERMINAL.has(ev?.type)) { done = true; if (ev.type !== "error") s.failures = 0; }
      yield ev;
      if (done) break;
    }
  } finally {
    clearInterval(ping);
    req.signal?.removeEventListener("abort", abort);
    if (!done && s.conn === conn && !conn.closed && !req.signal?.aborted) {
      // The consumer stopped early: the server may still be sending, so the socket cannot be reused.
      dropConn(s);
    } else if (done && conn && !conn.closed && s.conn === conn) {
      conn.idleTimer = setTimeout(() => { if (s.conn === conn) dropConn(s); }, idleCloseMs);
      (conn.idleTimer as any).unref?.();
    }
  }
}

/** Called when a turn finished: what the server now holds, so the next turn can be chained. */
export function wsReport(req: ModelRequest, t: { input: unknown[]; responseId?: string; assistantItems: unknown[] }): void {
  const s = states.get(req.sessionId);
  if (!s || !s.conn || s.conn.closed || !t.responseId) return;
  s.chain = { model: req.model.model, input: t.input.map((i) => JSON.stringify(i)), assistant: t.assistantItems.map((i) => JSON.stringify(i)), responseId: t.responseId };
}
