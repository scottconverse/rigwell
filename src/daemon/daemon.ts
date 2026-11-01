// The daemon: one process, many sessions. Each socket connection hosts one session (spec §2, §3.1.4).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "./connection.ts";
import { rigwellHome } from "../storage/paths.ts";

export const defaultSocketPath = () => join(rigwellHome(), "daemon.sock");

export async function startDaemon(opts: { socketPath: string; log?: (m: string) => void; retryBaseDelayMs?: number }) {
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
  const server = Bun.listen<Data>({
    unix: opts.socketPath,
    socket: {
      open(sock) {
        sock.data = { out: [] } as unknown as Data;
        const conn = createConnection((line) => { sock.data.out.push(enc.encode(line)); flush(sock); }, {
          canPrompt: true, log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs,
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
    get sessionCount() { return [...conns].filter((c) => c.session).length; },
    stop() {
      for (const c of conns) void c.shutdown();
      server.stop(true);
      try { unlinkSync(opts.socketPath); } catch {}
    },
  };
}
