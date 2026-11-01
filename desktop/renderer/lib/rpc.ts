// JSON-RPC over the preload bridge. One DaemonConn is one daemon connection (hosting at most one session).
import type { RigwellBridge } from "../../preload/preload.ts";

export const bridge = (): RigwellBridge => (window as unknown as { rigwell: RigwellBridge }).rigwell;

const PREFIX = "rigwell.";
const PROTOCOL = "0.1.0";

export class RpcFailure extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

type Pending = { resolve(v: any): void; reject(e: Error): void };
const conns = new Map<number, DaemonConn>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  bridge().daemon.onMessage(({ connId, message }) => conns.get(connId)?.handle(message));
  bridge().daemon.onClosed(({ connId }) => { conns.get(connId)?.finish(); });
}

export class DaemonConn {
  private pending = new Map<string, Pending>();
  closed = false;
  onNotification: (method: string, params: Record<string, any>) => void = () => {};
  /** Answers requests from the harness (request_permission, ask_user, pick_options). */
  onRequest: (method: string, params: Record<string, any>) => Promise<unknown> = async () => ({});
  onClose: () => void = () => {};

  private constructor(readonly id: number) {}

  static async open(): Promise<DaemonConn> {
    wire();
    const id = await bridge().daemon.open();
    const c = new DaemonConn(id);
    conns.set(id, c);
    return c;
  }

  private send(msg: Record<string, unknown>) {
    if (this.closed) return;
    void bridge().daemon.sendMessage(this.id, JSON.stringify({ jsonrpc: "2.0", protocolVersion: PROTOCOL, ...msg })).catch(() => this.finish());
  }

  /** `method` without the prefix, e.g. "add_user_message" or "daemon.list_files". */
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcFailure(-32005, "connection closed"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "request", id, method: PREFIX + method, params });
    });
  }

  handle(line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    const type = m.type ?? (m.method ? (m.id != null ? "request" : "notification") : "response");
    if (type === "response") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new RpcFailure(m.error.code, m.error.message, m.error.data)); else p.resolve(m.result);
    } else if (type === "notification") {
      this.onNotification(String(m.method).replace(PREFIX, ""), m.params ?? {});
    } else if (type === "request") {
      const method = String(m.method).replace(PREFIX, "");
      void Promise.resolve(this.onRequest(method, m.params ?? {}))
        .then((result) => this.send({ type: "response", id: m.id, result: result ?? {} }))
        .catch((e) => this.send({ type: "response", id: m.id, error: { code: -32603, message: String(e?.message ?? e) } }));
    }
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    conns.delete(this.id);
    for (const p of this.pending.values()) p.reject(new RpcFailure(-32005, "connection closed"));
    this.pending.clear();
    this.onClose();
  }

  close() { if (this.closed) return; void bridge().daemon.close(this.id); this.finish(); }
}
