// MCP transports: stdio (newline-delimited JSON-RPC), streamable HTTP (POST; JSON or SSE response),
// and legacy SSE (GET stream + POST endpoint). JSON-RPC 2.0.
import { spawn, type ChildProcess } from "node:child_process";
import { McpAuthRequiredError, mcpAuthHeaders, oauthEnabled } from "./oauth.ts";
import type { McpServerConfig } from "./types.ts";

/** Extra request headers per request (the OAuth bearer token). */
export type AuthHeaders = () => Promise<Record<string, string>>;
const noAuth: AuthHeaders = async () => ({});

/** A 401 from an http or sse server: sign-in needed when OAuth applies, else a plain error. */
function unauthorized(cfg: McpServerConfig, res: Response): Error {
  if (res.status === 401 && oauthEnabled(cfg)) return new McpAuthRequiredError(cfg.name, res.headers.get("www-authenticate") ?? undefined);
  return new McpRpcError(`HTTP ${res.status}: authorization required${oauthEnabled(cfg) ? "" : " (check the authorization header in headers)"}`);
}

export class McpRpcError extends Error {
  constructor(message: string, public code?: number, public data?: unknown) { super(message); }
}

export interface Connection {
  /** Start the transport (spawn / open stream). */
  start(): Promise<void>;
  request(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  /** Set by the owner; fires once when the transport ends on its own (not after close()). */
  onClose?: (reason: string) => void;
  /** Last stderr text (stdio) for error messages. */
  stderrTail?(): string;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

/** Shared JSON-RPC bookkeeping. */
abstract class Base implements Connection {
  protected nextId = 1;
  protected pending = new Map<number, Pending>();
  protected closed = false;
  onClose?: (reason: string) => void;
  abstract start(): Promise<void>;
  abstract close(): Promise<void>;
  protected abstract post(msg: object): Promise<void>;

  request(method: string, params?: unknown, timeoutMs = 30000, signal?: AbortSignal): Promise<any> {
    if (this.closed) return Promise.reject(new McpRpcError("connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject };
      p.timer = setTimeout(() => { this.pending.delete(id); reject(new McpRpcError(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      const done = (fn: () => void) => { clearTimeout(p.timer); signal?.removeEventListener("abort", onAbort); fn(); };
      const onAbort = () => { this.pending.delete(id); done(() => reject(new McpRpcError("cancelled"))); void this.notify("notifications/cancelled", { requestId: id }).catch(() => {}); };
      p.resolve = (v) => done(() => resolve(v));
      p.reject = (e) => done(() => reject(e));
      this.pending.set(id, p);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort); }
      this.post({ jsonrpc: "2.0", id, method, params }).catch((e) => { this.pending.delete(id); p.reject(e instanceof Error ? e : new McpRpcError(String(e))); });
    });
  }
  async notify(method: string, params?: unknown): Promise<void> { await this.post({ jsonrpc: "2.0", method, params }); }

  /** Feed one parsed incoming message. */
  protected handle(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new McpRpcError(String(msg.error.message ?? "error"), msg.error.code, msg.error.data));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      // server -> client request: answer ping, refuse the rest
      const result = msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
      void this.post(result).catch(() => {});
    }
  }
  protected failAll(reason: string) {
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new McpRpcError(reason)); }
  }
  protected ended(reason: string) {
    const was = this.closed;
    this.closed = true;
    this.failAll(reason);
    if (!was) this.onClose?.(reason);
  }
}

// ------------------------------------------------------------------ stdio
export class StdioConnection extends Base {
  private child?: ChildProcess;
  private buf = "";
  private err = "";
  constructor(private cfg: McpServerConfig, private cwd?: string) { super(); }
  stderrTail = () => this.err.slice(-2000).trim();

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = spawn(this.cfg.command!, this.cfg.args ?? [], {
        cwd: this.cwd, env: { ...process.env, ...this.cfg.env }, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = c;
      c.once("spawn", () => resolve());
      c.once("error", (e) => { reject(new McpRpcError(`failed to start: ${e.message}`)); this.ended(`process error: ${e.message}`); });
      c.stdout!.on("data", (d) => {
        this.buf += d.toString();
        let i: number;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          try { this.handle(JSON.parse(line)); } catch { /* not JSON: ignore noise */ }
        }
      });
      c.stderr!.on("data", (d) => { this.err = (this.err + d.toString()).slice(-4000); });
      c.stdin!.on("error", () => {});
      c.on("close", (code, sig) => this.ended(`process exited (${sig ?? code})${this.err ? ": " + this.stderrTail() : ""}`));
    });
  }
  protected async post(msg: object): Promise<void> {
    if (!this.child?.stdin?.writable) throw new McpRpcError("connection closed");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.failAll("connection closed");
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    try { c.stdin?.end(); } catch { /* ignore */ }
    await new Promise<void>((res) => {
      const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } res(); }, 1500);
      c.once("close", () => { clearTimeout(t); res(); });
      try { c.kill("SIGTERM"); } catch { /* gone */ }
    });
  }
}

// ------------------------------------------------------------------ SSE parsing
/** Parse an SSE byte stream into events. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = "message"; const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------ streamable HTTP
export class HttpConnection extends Base {
  private sessionId?: string;
  private ac = new AbortController();
  constructor(private cfg: McpServerConfig, private auth: AuthHeaders = noAuth) { super(); }
  async start() { /* stateless until initialize */ }

  protected async post(msg: object): Promise<void> {
    const auth = await this.auth();
    const res = await fetch(this.cfg.url!, {
      method: "POST", signal: this.ac.signal,
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...(this.cfg.headers ?? {}), ...auth,
      },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) { void res.body?.cancel(); throw unauthorized(this.cfg, res); }
    if (!res.ok && res.status !== 202) throw new McpRpcError(`HTTP ${res.status} ${res.statusText}`);
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 202 || !res.body) { void res.body?.cancel(); return; }
    const isRequest = "id" in msg && "method" in msg;
    if (ct.includes("text/event-stream")) {
      // Responses arrive on the stream; read in the background so post() resolves once the stream starts.
      void (async () => {
        try { for await (const ev of sseEvents(res.body!)) this.handle(safeJson(ev.data)); }
        catch (e) { if (isRequest) this.failId((msg as any).id, e); }
      })();
    } else if (ct.includes("application/json")) {
      const j = await res.json();
      for (const m of Array.isArray(j) ? j : [j]) this.handle(m);
    } else void res.body.cancel();
  }
  private failId(id: number, e: unknown) {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.reject(new McpRpcError(`stream error: ${(e as Error).message}`)); }
  }
  async close(): Promise<void> {
    this.closed = true; this.failAll("connection closed");
    if (this.sessionId) {
      try { await fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...(this.cfg.headers ?? {}), ...(await this.auth()) }, signal: AbortSignal.timeout(1500) }); } catch { /* best effort */ }
    }
    this.ac.abort();
  }
}

// ------------------------------------------------------------------ legacy SSE
export class LegacySseConnection extends Base {
  private ac = new AbortController();
  private endpoint?: string;
  constructor(private cfg: McpServerConfig, private auth: AuthHeaders = noAuth) { super(); }

  async start(): Promise<void> {
    const res = await fetch(this.cfg.url!, { headers: { accept: "text/event-stream", ...(this.cfg.headers ?? {}), ...(await this.auth()) }, signal: this.ac.signal });
    if (res.status === 401 || res.status === 403) { void res.body?.cancel(); throw unauthorized(this.cfg, res); }
    if (!res.ok || !res.body) throw new McpRpcError(`HTTP ${res.status} ${res.statusText}`);
    let gotEndpoint!: () => void;
    const ready = new Promise<void>((r) => (gotEndpoint = r));
    void (async () => {
      try {
        for await (const ev of sseEvents(res.body!)) {
          if (ev.event === "endpoint") { this.endpoint = new URL(ev.data.trim(), this.cfg.url).toString(); gotEndpoint(); }
          else this.handle(safeJson(ev.data));
        }
        this.ended("event stream ended");
      } catch (e) { if (!this.closed) this.ended(`event stream error: ${(e as Error).message}`); }
    })();
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new McpRpcError("no endpoint event from SSE server")), 10000))]);
  }
  protected async post(msg: object): Promise<void> {
    if (!this.endpoint) throw new McpRpcError("not connected");
    const res = await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(this.cfg.headers ?? {}), ...(await this.auth()) }, body: JSON.stringify(msg) });
    if (res.status === 401 || res.status === 403) { void res.body?.cancel(); throw unauthorized(this.cfg, res); }
    if (!res.ok && res.status !== 202) throw new McpRpcError(`HTTP ${res.status} ${res.statusText}`);
    void res.body?.cancel();
  }
  async close(): Promise<void> { this.closed = true; this.failAll("connection closed"); this.ac.abort(); }
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/** `auth` defaults to the stored OAuth sign-in of the server (none when nobody signed in). */
export function createConnection(cfg: McpServerConfig, cwd?: string, auth: AuthHeaders = () => mcpAuthHeaders(cfg)): Connection {
  if (cfg.type === "stdio") return new StdioConnection(cfg, cwd);
  if (cfg.type === "sse") return new LegacySseConnection(cfg, auth);
  return new HttpConnection(cfg, auth);
}
