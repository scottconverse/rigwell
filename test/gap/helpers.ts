// Helpers for the gap-wave tests: an in-process connection whose client can answer the harness's requests.
import { createConnection, type ConnectionOptions } from "../../src/daemon/connection.ts";

export type Answerer = (method: string, params: any) => any | Promise<any>;

export function driver(opts: { canPrompt?: boolean; answer?: Answerer; conn?: Partial<ConnectionOptions> } = {}) {
  const out: any[] = [];
  const requests: { method: string; params: any }[] = [];
  let answer = opts.answer;
  const make = () => {
    const conn: ReturnType<typeof createConnection> = createConnection((line) => {
      for (const l of line.split("\n")) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        out.push(m);
        if (m.type === "request") {
          const method = String(m.method).replace(/^rigwell\./, "");
          requests.push({ method, params: m.params });
          void Promise.resolve()
            .then(() => (answer ? answer(method, m.params) : Promise.reject(new Error("no answerer"))))
            .then(
              (result) => conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "response", id: m.id, result }) + "\n"),
              (e) => conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "response", id: m.id, error: { code: -32601, message: String(e?.message ?? e) } }) + "\n"),
            );
        }
      }
    }, { canPrompt: opts.canPrompt ?? true, retryBaseDelayMs: 1, ...opts.conn });
    return conn;
  };
  const conn = make();
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
  const d = {
    conn, out, requests,
    setAnswer(a: Answerer | undefined) { answer = a; },
    async call(method: string, params: Record<string, unknown> = {}) {
      const id = `d${++n}`;
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      const r = await until(() => out.find((m) => m.type === "response" && m.id === id));
      if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { code: r.error.code });
      return r.result;
    },
    notes: (type?: string) => out.filter((m) => m.method === "rigwell.session_notification").map((m) => m.params.notification).filter((x) => !type || x.type === type),
    until,
    completed: () => d.notes("agent_turn_completed"),
    async turn(text: string, extra: Record<string, unknown> = {}) {
      const before = d.completed().length;
      await d.call("add_user_message", { text, ...extra });
      await until(() => d.completed().length > before);
      return d.completed().at(-1);
    },
  };
  return d;
}
