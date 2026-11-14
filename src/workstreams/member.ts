// A Workstream member owns a normal connection for its lifetime, including idle time between turns.
import { createConnection } from "../daemon/connection.ts";
import type { AutonomyLevel, Tool } from "../core/types.ts";
import type { ConnectionOptions } from "../daemon/connection.ts";

export interface MemberHost {
  notify(n: Record<string, any>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  tools(tools: Tool[]): Tool[];
}
export class MemberSession {
  readonly connection: ReturnType<typeof createConnection>;
  private sequence = 0;
  private pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>();
  constructor(host: MemberHost, log?: (m: string) => void, maxAutonomy?: AutonomyLevel, limits: Pick<ConnectionOptions, "beforeTurn" | "maxToolIds" | "onUsage" | "beforeModel"> = {}) {
    this.connection = createConnection((line) => {
      for (const text of line.split("\n").filter(Boolean)) {
        const m = JSON.parse(text);
        if (m.type === "response") {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result);
        } else if (m.type === "request") {
          void host.request(String(m.method).replace(/^rigwell\./, ""), m.params ?? {}).then(
            (result) => this.feed({ type: "response", id: m.id, result }),
            (e) => this.feed({ type: "response", id: m.id, error: { code: e?.code ?? -32603, message: e?.message ?? "Member request failed" } }),
          );
        } else if (m.params?.notification) host.notify(m.params.notification);
      }
    }, { canPrompt: true, wrapTools: host.tools, log, retryBaseDelayMs: 1, maxAutonomy, ...limits });
  }
  private feed(message: Record<string, unknown>) { this.connection.peer.feed(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `member-${++this.sequence}`;
      this.pending.set(id, { resolve, reject }); this.feed({ type: "request", id, method: `rigwell.${method}`, params });
    });
  }
  async close() {
    await this.connection.shutdown();
    for (const p of this.pending.values()) p.reject(new Error("Member closed")); this.pending.clear();
  }
}
