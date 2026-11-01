// Side pane service (spec §17): Files, Terminal, Browser and Side chat on the daemon.
//
// Wire methods (prefix rigwell., names as in the spec's daemon.* family):
//   daemon.list_files, daemon.search_files, daemon.get_workspace_file_content, daemon.write_workspace_file_content,
//   daemon.create_terminal, daemon.write_terminal_data, daemon.resize_terminal, daemon.close_terminal, daemon.list_terminals,
//   daemon.browser_attach, daemon.browser_detach, daemon.browser_status,
//   daemon.side_chat_ask, daemon.side_chat_list, daemon.side_chat_cancel, daemon.side_chat_set_writes, daemon.side_chat_promote.
// Notifications (inside rigwell.session_notification): daemon.terminal_data, daemon.terminal_exit, daemon.side_chat_entry.
//
// One connection hosts one session, so each method resolves the session from the connection (params.sessionId, when
// present, must match). `methodsFor(ctx)` returns the method table for one connection; the daemon passes it as
// `extraMethods` and calls `connectionClosed(ctx)` when the connection drops.
import type { Message, Tool } from "../core/types.ts";
import { Session } from "../agent/session.ts";
import { createAdapter } from "../adapters/index.ts";
import { streamWithRetry } from "../adapters/retry.ts";
import { decide } from "../permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../permissions/lists.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { findModel, resolveModels } from "../storage/models.ts";
import { loadSettings } from "../storage/settings.ts";
import { listSessions } from "../storage/transcript.ts";
import { toolsForSession } from "../tools/registry.ts";
import { BrowserRegistry, createBrowserTool } from "./browser.ts";
import { listFiles, readWorkspaceFile, searchFiles, writeWorkspaceFile } from "./files.ts";
import { TerminalManager, type TerminalOptions, type TerminalOwner } from "./pty.ts";
import { SideChat, type ForkInfo, type SideChatEntry } from "./sidechat.ts";
import { hasBtwTag, openBtwFork, promoteBtwFork } from "./btw-store.ts";
import { readSessionSettings } from "../storage/session-settings.ts";
import { filesFor } from "../storage/transcript.ts";

export * from "./files.ts";
export * from "./pty.ts";
export * from "./browser.ts";
export * from "./sidechat.ts";
export * from "./btw-store.ts";

/** What the side pane needs to know about one connection. */
export interface ConnCtx {
  id: string;
  session(): Session | undefined;
  /** Sends a session_notification to this connection's client. */
  notify(n: Record<string, unknown>): void;
}

type Params = Record<string, unknown>;

export interface SidePaneOptions {
  log?: (m: string) => void;
  terminals?: TerminalOptions;
  /** CDP endpoints are accepted only on this port (the desktop's CDP proxy). */
  browserPort?: number;
  /** Endpoint to use when the app has not attached one (RIGWELL_BROWSER_CDP_URL). */
  browserDefaultUrl?: string;
  browserIdleMs?: number;
  /** Builds the side-chat fork (tests may replace it). */
  forkSession?: (main: Session, messages: Message[], host: ConstructorParameters<typeof Session>[1], info: ForkInfo) => Session | Promise<Session>;
}

/**
 * Default fork: same model and settings as the main session, stored under btw/ with the btw-fork tag. Write tools
 * (Edit, Create) are left out unless the user turned writes on; permission requests are auto-rejected either way.
 */
export async function defaultFork(main: Session, messages: Message[], host: ConstructorParameters<typeof Session>[1], info: ForkInfo = { priorExchanges: [], writes: false }): Promise<Session> {
  const loaded = loadSettings({ cwd: main.cwd });
  const s = loaded.settings;
  const models = resolveModels(s);
  const id = crypto.randomUUID();
  const stored = await openBtwFork({ id, mainId: main.id, cwd: main.cwd, messages, priorExchanges: info.priorExchanges });
  const tools = (o: { autonomy: "off" | "low" | "medium" | "high"; skipPermissions: boolean }): Tool[] =>
    toolsForSession({ autonomy: o.autonomy, skipPermissions: false }).filter((t) => info.writes || (t.name !== "Edit" && t.name !== "Create"));
  return new Session({
    id, cwd: main.cwd,
    settings: { ...main.settings, autonomyLevel: "low", interactionMode: "auto" },
    resolveModel: (mid) => findModel(models, mid),
    createAdapter, streamWithRetry: streamWithRetry as any,
    toolsFor: tools, decide,
    lists: { allow: s.commandAllowlist ?? DEFAULT_COMMAND_LISTS.allow, deny: s.commandDenylist ?? DEFAULT_COMMAND_LISTS.deny, block: s.commandBlocklist ?? DEFAULT_COMMAND_LISTS.block },
    skipPermissions: false, autoRejectPermissionRequests: true,
    shell: Bun.which("bash") ? "bash" : "sh",
    messages: [...messages],
    transcriptPath: stored.files.transcriptPath,
    persistence: stored.persistence,
  }, host);
}

export function createSidePane(opts: SidePaneOptions = {}) {
  const terminals = new TerminalManager({ ...opts.terminals, log: opts.log });
  const browsers = new BrowserRegistry({ expectedPort: opts.browserPort, defaultUrl: opts.browserDefaultUrl, idleMs: opts.browserIdleMs, log: opts.log });
  const sideChats = new Map<string, SideChat>();
  const owners = new Map<string, TerminalOwner>();

  const bad = (m: string) => new RpcError(ErrorCodes.INVALID_PARAMS, m);

  function session(ctx: ConnCtx, p: Params): Session {
    const s = ctx.session();
    if (!s) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "No session: call initialize_session or load_session first");
    if (p.sessionId !== undefined && p.sessionId !== s.id) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `This connection is not session ${String(p.sessionId)}`);
    return s;
  }

  function owner(ctx: ConnCtx): TerminalOwner {
    let o = owners.get(ctx.id);
    if (!o) { o = { id: ctx.id, notify: (n) => ctx.notify(n) }; owners.set(ctx.id, o); }
    return o;
  }

  function sideChat(ctx: ConnCtx, s: Session): SideChat {
    let sc = sideChats.get(s.id);
    // Entries survive a reconnect; the emit target is always the current connection.
    const emitTo = (entry: SideChatEntry) => ctx.notify({ type: "daemon.side_chat_entry", entry });
    if (!sc) {
      sc = new SideChat({
        mainMessages: () => s.messages,
        fork: (messages, host, info) => (opts.forkSession ?? defaultFork)(s, messages, host, info),
        promote: async (forkId, title) => { const f = await promoteBtwFork(forkId, s.cwd, title); return { sessionId: f.id }; },
        emit: (e) => currentEmit.get(s.id)?.(e),
      });
      sideChats.set(s.id, sc);
    }
    currentEmit.set(s.id, emitTo);
    return sc;
  }
  const currentEmit = new Map<string, (e: SideChatEntry) => void>();

  const str = (p: Params, k: string) => { const v = p[k]; if (typeof v !== "string" || !v) throw bad(`${k} is required`); return v; };

  function methodsFor(ctx: ConnCtx): Record<string, (p: Params) => unknown> {
    return {
      // Sidebar: every stored session, newest first (no session needed on the connection).
      // Side-chat forks (tag btw-fork) are hidden unless includeBtwForks is set (spec 17.4).
      "daemon.list_sessions": (p) => ({
        sessions: listSessions()
          .filter((s) => p.includeBtwForks === true || !hasBtwTag(readSessionSettings({ settingsPath: s.transcriptPath.replace(/\.jsonl$/, ".settings.json") })))
          .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, updatedAt: s.mtimeMs })),
      }),
      "daemon.list_files": (p) => listFiles(session(ctx, p).cwd, p),
      "daemon.search_files": (p) => searchFiles(session(ctx, p).cwd, p),
      "daemon.get_workspace_file_content": (p) => readWorkspaceFile(session(ctx, p).cwd, p),
      "daemon.write_workspace_file_content": (p) => writeWorkspaceFile(session(ctx, p).cwd, p),

      "daemon.create_terminal": (p) => {
        const s = session(ctx, p);
        return terminals.create(owner(ctx), {
          sessionId: s.id, terminalId: str(p, "terminalId"), cols: p.cols as number | undefined, rows: p.rows as number | undefined,
          cwd: typeof p.cwd === "string" ? p.cwd : undefined, env: p.env as Record<string, unknown> | undefined,
          shell: typeof p.shell === "string" ? p.shell : undefined, defaultCwd: s.cwd,
        });
      },
      "daemon.write_terminal_data": (p) => terminals.write(owner(ctx), session(ctx, p).id, str(p, "terminalId"), typeof p.data === "string" ? p.data : (() => { throw bad("data is required"); })()),
      "daemon.resize_terminal": (p) => terminals.resize(owner(ctx), session(ctx, p).id, str(p, "terminalId"), Number(p.cols), Number(p.rows)),
      "daemon.close_terminal": (p) => terminals.close(owner(ctx), session(ctx, p).id, str(p, "terminalId")),
      "daemon.list_terminals": (p) => terminals.list(owner(ctx), session(ctx, p).id),

      "daemon.browser_attach": (p) => browsers.attach(session(ctx, p).id, p.cdpUrl),
      "daemon.browser_detach": (p) => browsers.detach(session(ctx, p).id),
      "daemon.browser_status": (p) => { const b = browsers.get(session(ctx, p).id); return { attached: !!b, connected: !!b?.connected }; },

      "daemon.side_chat_ask": (p) => {
        const s = session(ctx, p);
        const q = typeof p.question === "string" ? p.question.trim() : "";
        if (!q) throw bad("question is required");
        return { entry: sideChat(ctx, s).ask(q) };
      },
      "daemon.side_chat_list": (p) => { const s = session(ctx, p); const sc = sideChats.get(s.id); return { entries: sc?.entries ?? [], writes: sc?.writes ?? false }; },
      "daemon.side_chat_set_writes": (p) => {
        const s = session(ctx, p);
        if (typeof p.enabled !== "boolean") throw bad("enabled must be a boolean");
        sideChat(ctx, s).setWrites(p.enabled);
        return { writes: p.enabled };
      },
      "daemon.side_chat_promote": async (p) => {
        const s = session(ctx, p);
        const sc = sideChats.get(s.id);
        if (!sc) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, "No side chat in this session");
        try { return await sc.promote(str(p, "entryId")); } catch (e) { throw bad((e as Error).message); }
      },
      "daemon.side_chat_cancel": (p) => { sideChats.get(session(ctx, p).id)?.cancel(); return {}; },
    };
  }

  return {
    terminals, browsers, methodsFor,
    /** Agent tools this side pane contributes to every session (the Browser tool). */
    tools(): Tool[] { return [createBrowserTool(browsers)]; },
    /** The connection dropped: terminals start their grace timer. */
    connectionClosed(ctx: ConnCtx) {
      const o = owners.get(ctx.id);
      if (o) { terminals.release(o); owners.delete(ctx.id); }
      const s = ctx.session();
      if (s) currentEmit.delete(s.id);
    },
    sideChatFor(sessionId: string) { return sideChats.get(sessionId); },
    closeAll() { terminals.closeAll(); browsers.closeAll(); },
  };
}

export type SidePane = ReturnType<typeof createSidePane>;
