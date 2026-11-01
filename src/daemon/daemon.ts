// The daemon: one process, many sessions. Each socket connection hosts one session (spec §2, §3.1.4).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "./connection.ts";
import { rigwellHome } from "../storage/paths.ts";
import { createAutomationService, type ServiceOptions } from "../automations/index.ts";
import { loadSettings } from "../storage/settings.ts";
import { METHOD_PREFIX } from "../protocol/rpc.ts";

export const defaultSocketPath = () => join(rigwellHome(), "daemon.sock");

export async function startDaemon(opts: { socketPath: string; log?: (m: string) => void; retryBaseDelayMs?: number; automations?: false | ServiceOptions }) {
  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  const conns = new Set<ReturnType<typeof createConnection>>();
  const dec = new TextDecoder();
  type Data = { conn: ReturnType<typeof createConnection>; out: Uint8Array[] };
  const enc = new TextEncoder();
  const flush = (sock: Bun.Socket<Data>) => {
    while (sock.data.out.length) {
      const buf = sock.data.out[0];
      const n = sock.write(buf);
      if (n < buf.length) { sock.data.out[0] = buf.subarray(Math.max(n, 0)); return; }
      sock.data.out.shift();
    }
  };
  // Automations and session crons run only while the daemon runs (spec §16).
  const auto = opts.automations === false ? undefined : (() => {
    const cfg = (loadSettings({ cwd: rigwellHome() }).settings.automations ?? {}) as { webhookPort?: number; webhookHost?: string };
    const live = (id: string) => [...conns].find((c) => c.session?.id === id)?.session;
    return createAutomationService({
      log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs, webhookPort: cfg.webhookPort ?? 47821, webhookHost: cfg.webhookHost,
      cronHost: {
        isLive: (id) => !!live(id),
        isBusy: (id) => !!live(id)?.isRunning,
        inject: (id, prompt) => { const s = live(id); if (!s) return false; s.addUserMessage(prompt); return true; },
      },
      onCronChanged: (cron) => { for (const c of conns) c.peer.notify(METHOD_PREFIX + "cron_state_changed", { cron }); },
      ...opts.automations,
    });
  })();
  auto?.start();
  const server = Bun.listen<Data>({
    unix: opts.socketPath,
    socket: {
      open(sock) {
        sock.data = { out: [] } as unknown as Data;
        const conn = createConnection((line) => { sock.data.out.push(enc.encode(line)); flush(sock); }, {
          canPrompt: true, log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs, extraMethods: auto?.methods,
        });
        sock.data.conn = conn;
        conns.add(conn);
      },
      drain(sock) { flush(sock); },
      data(sock, chunk) { sock.data.conn.peer.feed(dec.decode(chunk, { stream: true })); },
      close(sock) {
        conns.delete(sock.data.conn);
        void sock.data.conn.shutdown();
      },
    },
  });
  return {
    socketPath: opts.socketPath,
    automations: auto,
    get sessionCount() { return [...conns].filter((c) => c.session).length; },
    stop() {
      auto?.stop();
      for (const c of conns) void c.shutdown();
      server.stop(true);
      try { unlinkSync(opts.socketPath); } catch {}
    },
  };
}
