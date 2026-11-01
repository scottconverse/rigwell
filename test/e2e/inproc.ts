// An in-process daemon connection driven with the real protocol methods (so tests can reach the Session).
import { createConnection } from "../../src/daemon/connection.ts";

/** An in-process connection driven with the real protocol methods. */
export function inproc(opts: { canPrompt?: boolean } = {}) {
  const out: any[] = [];
  const conn = createConnection((line) => { for (const l of line.split("\n")) if (l.trim()) out.push(JSON.parse(l)); }, { canPrompt: opts.canPrompt ?? false, retryBaseDelayMs: 1 });
  let n = 0;
  const until = async (pred: () => any, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error("timeout");
      await Bun.sleep(2);
    }
  };
  return {
    conn, out,
    async call(method: string, params: Record<string, unknown>) {
      const id = `c${++n}`;
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      const r = await until(() => out.find((m) => m.type === "response" && m.id === id));
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result;
    },
    async turn(text: string) {
      const before = out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length;
      await this.call("add_user_message", { text });
      await until(() => out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length > before);
    },
    notes: () => out.filter((m) => m.method === "rigwell.session_notification").map((m) => m.params.notification),
  };
}

