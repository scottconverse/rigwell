// Local WebSocket listener for the daemon (spec §2: "WebSocket JSON-RPC"). Each WS connection is one session;
// each text frame is exactly one JSON-RPC message (no newline framing needed).
//
// Security model:
//  - binds 127.0.0.1 only (never a configurable host);
//  - a random token is required on the upgrade request, as `?token=<t>` or `Authorization: Bearer <t>`;
//    a missing or wrong token gets 401 and no upgrade happens;
//  - the Host header must be loopback (blocks DNS rebinding);
//  - the token lives in $RIGWELL_HOME/daemon.json, written with mode 0600, next to the socket path and WS URL.
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export const DEFAULT_WS_PORT = 47822;

export interface WsServerOptions {
  /** 0 picks a free port. */
  port: number;
  /** Fixed token (tests). Default: 32 random bytes, hex. */
  token?: string;
  /** Called per accepted WebSocket. `write` sends one message; returns the handler for incoming messages. */
  open(write: (message: string) => void): { feed(message: string): void; close(): void };
  log?: (m: string) => void;
}

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function startWsServer(opts: WsServerOptions) {
  const token = opts.token ?? randomBytes(32).toString("hex");
  interface Data { conn?: ReturnType<WsServerOptions["open"]> }
  const server = Bun.serve<Data, {}>({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!LOOPBACK_HOST.test(req.headers.get("host") ?? "")) return new Response("forbidden", { status: 403 });
      const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
      if (!tokenOk(url.searchParams.get("token") ?? bearer, token)) return new Response("unauthorized", { status: 401 });
      if (srv.upgrade(req, { data: {} as Data })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) { ws.data.conn = opts.open((m) => { ws.send(m.replace(/\n+$/, "")); }); },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        let line = text;
        // One frame is one message: collapse any pretty-printing so the NDJSON peer sees a single line.
        try { line = JSON.stringify(JSON.parse(text)); } catch { line = text.replace(/\r?\n/g, " "); }
        ws.data.conn?.feed(line);
      },
      close(ws) { ws.data.conn?.close(); },
    },
  });
  return {
    port: server.port as number,
    url: `ws://127.0.0.1:${server.port}/`,
    token,
    stop() { server.stop(true); },
  };
}

export interface DaemonInfoFile {
  pid: number;
  socketPath: string;
  ws?: { url: string; host: string; port: number };
  token?: string;
  startedAt: string;
}

const infoPath = (home: string) => join(home, "daemon.json");

/** Writes daemon.json with mode 0600 (the token is a credential). */
export function writeDaemonInfo(home: string, info: DaemonInfoFile) {
  const p = infoPath(home);
  writeFileSync(p, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** Removes daemon.json only if it still belongs to this daemon. */
export function removeDaemonInfo(home: string, pid: number, token?: string) {
  try {
    const cur = JSON.parse(readFileSync(infoPath(home), "utf8")) as DaemonInfoFile;
    if (cur.pid === pid && cur.token === token) unlinkSync(infoPath(home));
  } catch {}
}
