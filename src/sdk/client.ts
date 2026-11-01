// JSON-RPC client over a Transport: requests with timeouts, notifications, and harness -> client requests.
import { ErrorCodes, METHOD_PREFIX, PROTOCOL_VERSION, RpcError } from "../protocol/rpc.ts";
import type { Transport } from "./transport.ts";

export type IncomingRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;

/** Request timeouts from spec §3.1.5 (ms). Methods not listed have none. */
const TIMEOUTS: Record<string, number> = {
  initialize_session: 60_000, load_session: 60_000, interrupt_session: 30_000, close_session: 30_000,
  update_session_settings: 30_000, compact_session: 240_000, fork_session: 30_000, list_tools: 30_000,
  list_models: 30_000, list_mcp_servers: 30_000, get_context_stats: 30_000,
};

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

export class RpcClient {
  private pending = new Map<string, Pending>();
  private closed = false;
  closeError?: Error;
  onNotification: (method: string, params: Record<string, any>) => void = () => {};
  onRequest: IncomingRequestHandler = () => { throw new RpcError(ErrorCodes.METHOD_NOT_FOUND, "no handler"); };
  onClose: () => void = () => {};

  constructor(readonly transport: Transport, private timeouts: Record<string, number> = TIMEOUTS) {
    transport.onMessage = (line) => this.handle(line);
    transport.onClose = (err) => this.finish(err);
  }

  get isClosed() { return this.closed; }

  private send(msg: Record<string, unknown>) {
    if (this.closed) return;
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", protocolVersion: PROTOCOL_VERSION, ...msg }));
  }

  /** `method` is the bare name, e.g. "add_user_message". */
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new RpcError(ErrorCodes.SESSION_DISCONNECTED, this.closeError?.message ?? "connection closed"));
      const entry: Pending = { resolve, reject };
      const ms = this.timeouts[method];
      if (ms) entry.timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(ErrorCodes.INTERNAL_ERROR, `${method} timed out after ${ms} ms`)); }, ms);
      this.pending.set(id, entry);
      this.send({ type: "request", id, method: METHOD_PREFIX + method, params });
    });
  }

  private handle(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const type = msg.type ?? (msg.method ? (msg.id != null ? "request" : "notification") : "response");
    if (type === "response") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    } else if (type === "notification") {
      if (typeof msg.method === "string") this.onNotification(msg.method.replace(METHOD_PREFIX, ""), msg.params ?? {});
    } else if (type === "request" && typeof msg.id === "string" && typeof msg.method === "string") {
      const id = msg.id;
      const method = msg.method.startsWith(METHOD_PREFIX) ? msg.method.slice(METHOD_PREFIX.length) : msg.method;
      void (async () => {
        try {
          const result = await this.onRequest(method, msg.params ?? {});
          this.send({ type: "response", id, result: result ?? {} });
        } catch (e) {
          const code = e instanceof RpcError ? e.code : ErrorCodes.INTERNAL_ERROR;
          this.send({ type: "response", id, error: { code, message: String((e as Error)?.message ?? e) } });
        }
      })();
    }
  }

  private finish(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(ErrorCodes.SESSION_DISCONNECTED, err?.message ?? "connection closed"));
    }
    this.pending.clear();
    this.onClose();
  }

  async close() { await this.transport.close(); this.finish(); }
}
