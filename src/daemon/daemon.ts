// The daemon: one process, many sessions. Each socket connection hosts one session (spec §2, §3.1.4).
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginService } from "../plugins/service.ts";
import { wikiMethods } from "../wiki/wiki.ts";
import { academyMethods } from "../academy/practice.ts";
import { analyticsMethods } from "../analytics/analytics.ts";
import { evalMethods } from "../eval/view.ts";
import { spendMethods } from "../spend/spend.ts";
import { createConnection } from "./connection.ts";
import { rigwellHome } from "../storage/paths.ts";
import { automationTools, createAutomationService, type ServiceOptions } from "../automations/index.ts";
import { onWorktreeNotification, startWorktreeHousekeeping } from "../worktree/connect.ts";
import { loadSettings } from "../storage/settings.ts";
import { METHOD_PREFIX } from "../protocol/rpc.ts";
import { createMissionService } from "../missions/index.ts";
import { createWorkstreamService } from "../workstreams/index.ts";
import { createSidePane, type ConnCtx, type SidePaneOptions } from "../sidepane/index.ts";
import { DEFAULT_WS_PORT, removeDaemonInfo, startWsServer, writeDaemonInfo } from "./ws.ts";
import { runningSessionCount, stopLiveSessions } from "../machines/live-sessions.ts";
import { machineRuntimeInfo } from "../machines/runtime-info.ts";
import { listWorkstreamStores } from "../workstreams/store.ts";
import { PhoneAccess } from "../phone/server.ts";
import { PhoneStore } from "../phone/store.ts";
import { SlackHub } from "../automations/triggers/slack.ts";
import { DelegationService, type DelegationDeps } from "../delegation/service.ts";
import { DelegationStore } from "../delegation/store.ts";
import { InboxService, type InboxDeps } from "../inbox/service.ts";

export const defaultSocketPath = () => join(rigwellHome(), "daemon.sock");

export async function startDaemon(opts: { socketPath: string; onShutdown?: () => void; advertise?: boolean; backgroundServices?: boolean; log?: (m: string) => void; retryBaseDelayMs?: number; inbox?: InboxDeps; automations?: false | ServiceOptions; delegation?: false | DelegationDeps; ws?: false | { port?: number; token?: string }; sidepane?: false | SidePaneOptions }) {
  mkdirSync(dirname(opts.socketPath), { recursive: true });
  if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
  const conns = new Set<ReturnType<typeof createConnection>>();
  const plugins = new PluginService();
  const inbox = new InboxService(undefined, opts.inbox, () => { for (const c of conns) c.peer.notify(METHOD_PREFIX + "inbox_changed", {}); }, opts.log);
  inbox.start();
  const dec = new TextDecoder();
  type Data = { conn: ReturnType<typeof createConnection>; out: Uint8Array[] };
  const enc = new TextEncoder();
  const slackHub = (opts.delegation && opts.delegation.slackHub) || (opts.automations && opts.automations.triggers?.slackHub) || new SlackHub(opts.automations ? opts.automations.triggers?.slack : undefined);
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
      triggers: { ...opts.automations?.triggers, slackHub },
      onRunCompleted: (a, run, text, event) => { inbox.automation(a, run); opts.automations && opts.automations.onRunCompleted?.(a, run, text, event); },
    });
  })();
  auto?.start();
  const autoTools = auto ? automationTools(auto) : [];
  // Worktrees (spec 18): removal and branch-change broadcasts, and the 5-minute housekeeping pass.
  const offWorktree = onWorktreeNotification((method, params) => { for (const c of conns) c.peer.notify(METHOD_PREFIX + method, params); });
  const housekeeping = opts.backgroundServices === false ? undefined : startWorktreeHousekeeping({ log: opts.log });
  // Side pane (spec §17): files, terminals, browser control and side chat. The app's CDP proxy port and endpoint
  // arrive through the environment (RIGWELL_BROWSER_CDP_PORT / RIGWELL_BROWSER_CDP_URL) or `daemon.browser_attach`.
  const sidepane = opts.sidepane === false ? undefined : createSidePane({
    log: opts.log,
    browserPort: Number(process.env.RIGWELL_BROWSER_CDP_PORT) || undefined,
    browserDefaultUrl: process.env.RIGWELL_BROWSER_CDP_URL,
    ...opts.sidepane,
  });
  const missions = createMissionService({ log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs });
  const workstreams = createWorkstreamService({ log: opts.log, recover: opts.backgroundServices, onNotification: (n, cwd) => inbox.workstream(n, cwd) });
  await workstreams.ready;
  const workstreamClients = new Map<ReturnType<typeof createConnection>, () => void>();
  const ctxs = new Map<ReturnType<typeof createConnection>, ConnCtx>();
  let shutdownRequested = false;
  let shutdownDaemon: () => void;
  const machineControl = {
    async stopSessions() {
      for (const handle of missions.handles.values()) handle.pause("machine_stop_sessions");
      for (const store of listWorkstreamStores()) if (store.read().state === "active") workstreams.pause(store.id, "Machine stop all sessions");
      const result = await stopLiveSessions();
      await Promise.all([...workstreams.members.values()].map((m) => m.call("interrupt_session", { clearQueued: true })));
      return { ...result, runningSessions: runningSessionCount() };
    },
    shutdown(build: unknown) {
      if (typeof build !== "string" || build !== machineRuntimeInfo().build) throw new Error("Refusing to stop a daemon with a different build");
      if (runningSessionCount() || missions.handles.size) throw new Error("Stop all running sessions before restarting or updating this machine");
      if (!shutdownRequested) { shutdownRequested = true; setTimeout(() => shutdownDaemon(), 0); }
      return { shuttingDown: true };
    },
  };
  const mkConn = (write: (line: string) => void) => {
    let conn!: ReturnType<typeof createConnection>;
    const ctx: ConnCtx = {
      id: crypto.randomUUID(),
      session: () => conn.session,
      notify: (n) => conn.peer.notify(METHOD_PREFIX + "session_notification", { ...(conn.session ? { sessionId: conn.session.id } : {}), notification: n }),
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      const own = !params.agentId && (method === "request_permission" || method === "ask_user");
      if (own) inbox.session(conn.session, { type: "user_prompt_requested", kind: method === "ask_user" ? "ask_user" : "permission", requestId: params.requestId });
      try { return await conn.peer.request(METHOD_PREFIX + method, params); }
      finally { if (own) inbox.session(conn.session, { type: method === "ask_user" ? "ask_user_resolved" : "permission_resolved", requestId: params.requestId }); }
    };
    const mission = missions.attach({
      session: () => conn.session, notify: (n) => { inbox.mission(conn.session, n); ctx.notify(n); },
      request,
    });
    const stream = workstreams.attach({ session: () => conn.session, notify: ctx.notify, request });
    conn = createConnection(write, {
      canPrompt: true, log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs,
      machineControl,
      onNotification: (s, n) => {
        inbox.session(s, n);
        if (s) workstreams.observe(s, n);
        if (s && ["create_message", "session_title_updated", "agent_turn_completed"].includes(String(n.type)) && (s.settingsSnapshot().tags as { name: string }[] | undefined)?.some((t) => t.name === "delegation-slack" || t.name === "delegation-teams")) {
          for (const c of conns) c.peer.notify(METHOD_PREFIX + "session_list_changed", { sessionId: s.id });
        }
      },
      sharedSession: (id) => {
        const member = workstreams.sharedSession(id); if (member) return member;
        const owner = [...conns].find((c) => !c.closed && c.session?.id === id), session = owner?.session;
        return owner && session ? { session, alive: () => conns.has(owner) && !owner.closed && owner.session === session, subscribe: (notify) => session.subscribeNotifications(notify) } : undefined;
      },
      sharedRemoteSession: workstreams.sharedRemoteSession,
      extraMethods: { ...auto?.methods, ...sidepane?.methodsFor(ctx), ...mission.methods, ...stream.methods, ...phone.methods, ...delegation?.methods, ...inbox.methods, ...plugins.methods, ...wikiMethods, ...academyMethods, ...analyticsMethods, ...evalMethods, ...spendMethods },
      notifyUserMessages: true,
      wrapTools: (tools) => stream.wrapTools(mission.wrapTools(tools)),
      extraTools: sidepane || autoTools.length ? () => [...(sidepane ? sidepane.tools() : []), ...autoTools] : undefined,
    });
    conns.add(conn);
    ctxs.set(conn, ctx);
    workstreamClients.set(conn, stream.close);
    return conn;
  };
  const dropConn = (conn: ReturnType<typeof createConnection>) => {
    workstreamClients.get(conn)?.(); workstreamClients.delete(conn);
    conns.delete(conn);
    const ctx = ctxs.get(conn);
    if (ctx) sidepane?.connectionClosed(ctx);
    ctxs.delete(conn);
    void conn.shutdown({ park: true });
  };
  const phone = new PhoneAccess(new PhoneStore(), (write) => {
    const conn = mkConn(write); return { feed: (m) => conn.peer.feed(m + "\n"), close: () => dropConn(conn) };
  }, opts.log);
  const delegation = opts.delegation === false ? undefined : new DelegationService(new DelegationStore(), (write) => {
    const conn = mkConn(write); return { feed: (line) => conn.peer.feed(line + "\n"), close: async () => { await conn.shutdown(); dropConn(conn); } };
  }, { ...opts.delegation, slackHub }, opts.log);
  await delegation?.start();
  await phone.restore();
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
    if (opts.advertise !== false) writeDaemonInfo(home, {
      pid: process.pid, socketPath: opts.socketPath, startedAt: new Date().toISOString(),
      ...(wsServer ? { ws: { url: wsServer.url, host: "127.0.0.1", port: wsServer.port }, token: wsServer.token } : {}),
    });
  } catch (e) {
    opts.log?.(`[daemon] could not write daemon.json: ${(e as Error).message}`);
  }
  let stopped: Promise<void> | undefined;
  const control = {
    socketPath: opts.socketPath,
    wsUrl: wsServer?.url,
    wsToken: wsServer?.token,
    automations: auto,
    workstreams,
    phone,
    delegation,
    inbox,
    plugins,
    get sessionCount() { return [...conns].filter((c) => c.session).length; },
    stop() {
      if (stopped) return stopped;
      for (const handle of missions.handles.values()) handle.pause("daemon_shutdown");
      const pending = [...conns].map((c) => c.shutdown());
      pending.push(inbox.stop());
      pending.push(plugins.close());
      if (delegation) pending.push(delegation.stop());
      pending.push(workstreams.stop());
      auto?.stop();
      offWorktree();
      housekeeping?.stop();
      if (sidepane) pending.push(sidepane.closeAll());
      server.stop(true);
      wsServer?.stop();
      phone.stop();
      if (opts.advertise !== false) removeDaemonInfo(home, process.pid, wsServer?.token);
      try { unlinkSync(opts.socketPath); } catch {}
      const done = stopped = Promise.all(pending).then(() => {});
      void done.catch((e) => opts.log?.(`[daemon] shutdown failed: ${(e as Error).message}`));
      return done;
    },
  };
  shutdownDaemon = opts.onShutdown ?? (() => { void control.stop(); });
  return control;
}
