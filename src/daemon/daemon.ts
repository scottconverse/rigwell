// The daemon: one process, many sessions. Each socket connection hosts one session (spec §2, §3.1.4).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "./connection.ts";
import { rigwellHome } from "../storage/paths.ts";
import { automationTools, createAutomationService, type ServiceOptions } from "../automations/index.ts";
import { onWorktreeNotification, startWorktreeHousekeeping } from "../worktree/connect.ts";
import { loadSettings } from "../storage/settings.ts";
import { METHOD_PREFIX } from "../protocol/rpc.ts";
import { createMissionService } from "../missions/index.ts";
import { createSidePane, type ConnCtx, type SidePaneOptions } from "../sidepane/index.ts";
import { DEFAULT_WS_PORT, removeDaemonInfo, startWsServer, writeDaemonInfo } from "./ws.ts";

export const defaultSocketPath = () => join(rigwellHome(), "daemon.sock");

export async function startDaemon(opts: { socketPath: string; log?: (m: string) => void; retryBaseDelayMs?: number; automations?: false | ServiceOptions; ws?: false | { port?: number; token?: string }; sidepane?: false | SidePaneOptions }) {
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
        inject: (id, prompt) => { const s = live(id); if (!s) return false; s.addUserMessage(prompt, undefined, "automation"); return true; },
      },
      onCronChanged: (cron) => { for (const c of conns) c.peer.notify(METHOD_PREFIX + "cron.state_changed", { cron }); },
      onAutoPaused: (a) => { for (const c of conns) c.peer.notify(METHOD_PREFIX + "automation.auto_paused", a); },
      ...opts.automations,
    });
  })();
  auto?.start();
  const autoTools = auto ? automationTools(auto) : [];
  // Worktrees (spec 18): removal and branch-change broadcasts, and the 5-minute housekeeping pass.
  const offWorktree = onWorktreeNotification((method, params) => { for (const c of conns) c.peer.notify(METHOD_PREFIX + method, params); });
  const housekeeping = startWorktreeHousekeeping({ log: opts.log });
  // Side pane (spec §17): files, terminals, browser control and side chat. The app's CDP proxy port and endpoint
  // arrive through the environment (RIGWELL_BROWSER_CDP_PORT / RIGWELL_BROWSER_CDP_URL) or `daemon.browser_attach`.
  const sidepane = opts.sidepane === false ? undefined : createSidePane({
    log: opts.log,
    browserPort: Number(process.env.RIGWELL_BROWSER_CDP_PORT) || undefined,
    browserDefaultUrl: process.env.RIGWELL_BROWSER_CDP_URL,
    ...opts.sidepane,
  });
  const missions = createMissionService({ log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs });
  const ctxs = new Map<ReturnType<typeof createConnection>, ConnCtx>();
  const mkConn = (write: (line: string) => void) => {
    let conn!: ReturnType<typeof createConnection>;
    const ctx: ConnCtx = {
      id: crypto.randomUUID(),
      session: () => conn.session,
      notify: (n) => conn.peer.notify(METHOD_PREFIX + "session_notification", { ...(conn.session ? { sessionId: conn.session.id } : {}), notification: n }),
    };
    const mission = missions.attach({
      session: () => conn.session, notify: ctx.notify,
      request: (m, p) => conn.peer.request(METHOD_PREFIX + m, p),
    });
    conn = createConnection(write, {
      canPrompt: true, log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs,
      extraMethods: { ...auto?.methods, ...sidepane?.methodsFor(ctx), ...mission.methods },
      wrapTools: mission.wrapTools,
      extraTools: sidepane || autoTools.length ? () => [...(sidepane ? sidepane.tools() : []), ...autoTools] : undefined,
    });
    conns.add(conn);
    ctxs.set(conn, ctx);
    return conn;
  };
  const dropConn = (conn: ReturnType<typeof createConnection>) => {
    conns.delete(conn);
    const ctx = ctxs.get(conn);
    if (ctx) sidepane?.connectionClosed(ctx);
    ctxs.delete(conn);
    void conn.shutdown({ park: true });
  };
  const server = Bun.listen<Data>({
    unix: opts.socketPath,
    socket: {
      open(sock) {
        sock.data = { out: [] } as unknown as Data;
        sock.data.conn = mkConn((line) => { sock.data.out.push(enc.encode(line)); flush(sock); });
      },
      drain(sock) { flush(sock); },
      data(sock, chunk) { sock.data.conn.peer.feed(dec.decode(chunk, { stream: true })); },
      close(sock) {
        dropConn(sock.data.conn);
      },
    },
  });
  // Local WebSocket (127.0.0.1, token required); see ws.ts. Port: opts.ws.port, else settings daemon.wsPort, else default.
  let wsServer: ReturnType<typeof startWsServer> | undefined;
  if (opts.ws !== false) {
    const cfg = (loadSettings({ cwd: rigwellHome() }).settings as { daemon?: { wsPort?: number } }).daemon ?? {};
    try {
      wsServer = startWsServer({
        port: opts.ws?.port ?? cfg.wsPort ?? DEFAULT_WS_PORT, token: opts.ws?.token, log: opts.log,
        open(write) {
          const conn = mkConn((line) => write(line));
          return {
            feed: (m) => conn.peer.feed(m + "\n"),
            close: () => dropConn(conn),
          };
        },
      });
    } catch (e) {
      opts.log?.(`[daemon] WebSocket listener disabled: ${(e as Error).message}`);
    }
  }
  const home = rigwellHome();
  try {
    writeDaemonInfo(home, {
      pid: process.pid, socketPath: opts.socketPath, startedAt: new Date().toISOString(),
      ...(wsServer ? { ws: { url: wsServer.url, host: "127.0.0.1", port: wsServer.port }, token: wsServer.token } : {}),
    });
  } catch (e) {
    opts.log?.(`[daemon] could not write daemon.json: ${(e as Error).message}`);
  }
  return {
    socketPath: opts.socketPath,
    wsUrl: wsServer?.url,
    wsToken: wsServer?.token,
    automations: auto,
    get sessionCount() { return [...conns].filter((c) => c.session).length; },
    stop() {
      auto?.stop();
      offWorktree();
      housekeeping.stop();
      sidepane?.closeAll();
      for (const c of conns) void c.shutdown();
      server.stop(true);
      wsServer?.stop();
      removeDaemonInfo(home, process.pid, wsServer?.token);
      try { unlinkSync(opts.socketPath); } catch {}
    },
  };
}
