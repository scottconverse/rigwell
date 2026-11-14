// MCP manager: parallel server startup, status tracking, tool naming, drop suppression (spec §5.7, §6.2).
import { McpClient } from "./client.ts";
import { ConnectorCatalog } from "./catalog.ts";
import { hasMcpTokens, McpAuthRequired, signInMcp, signOutMcp } from "./auth.ts";
import { authManager } from "../auth/oauth.ts";
import { fromAddParams, loadMcpConfig, removeUserServer, saveUserServer } from "./config.ts";
import type {
  AddMcpServerParams, McpCallResult, McpServerConfig, McpServerStatusInfo, McpStatus, McpStatusSummary, McpToolDef, McpToolInfo,
} from "./types.ts";

/** Connects-and-drops count at which a server is suppressed (spec §6.2: "6 or more"). */
export const MAX_DROPS = 6;

/** Model-facing id for a tool: `server__tool`. Characters outside [A-Za-z0-9_-] in the server name become `_`. */
export function mcpLlmName(server: string, tool: string): string {
  return `${server.replace(/[^A-Za-z0-9_-]/g, "_")}__${tool}`;
}
/** Script binding path for a tool: `server.tool` (reachable as `tools.server.tool`). */
export function mcpBindingName(server: string, tool: string): string {
  return `${server.replace(/[^A-Za-z0-9_]/g, "_")}.${tool}`;
}

interface Entry {
  cfg: McpServerConfig;
  status: McpStatus;
  error?: string;
  requiresAuth?: boolean;
  client?: McpClient;
  defs: McpToolDef[];
  drops: number;
  /** Bumped on remove/restart so stale async work is ignored. */
  epoch: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface McpManagerOptions {
  cwd?: string;
  /** false: the folder is not trusted, so project mcp.json files are skipped (spec 12.2). */
  projectTrusted?: boolean;
  /** Called on every status change (emit `mcp_status_changed` notifications from it). */
  onStatusChanged?: (info: McpServerStatusInfo) => void;
  connectTimeoutMs?: number;
  /** Delay before reconnecting after an unexpected drop. Default 1000. */
  reconnectDelayMs?: number;
  maxDrops?: number;
  /** Client constructor hook for tests. */
  clientCtor?: (cfg: McpServerConfig, cwd?: string) => McpClient;
}

export class McpManager {
  private catalog = new ConnectorCatalog();
  private entries = new Map<string, Entry>();
  private pendingStarts: Promise<unknown>[] = [];
  private logins = new Map<string, string>();
  configError?: { path: string; message: string };
  warnings: string[] = [];

  constructor(private o: McpManagerOptions = {}) {}

  /** Load mcp.json (user/project/folder) and start those servers plus `extra` (initialize_session). Does not block. */
  startFromConfig(extra: McpServerConfig[] = []): Promise<void> {
    const loaded = loadMcpConfig({ cwd: this.o.cwd ?? process.cwd(), trustProject: this.o.projectTrusted });
    this.configError = loaded.configError;
    this.warnings.push(...loaded.warnings);
    const names = new Set(extra.map((c) => c.name));
    // initialize_session servers override file config of the same name
    return this.start([...extra, ...loaded.servers.filter((c) => !names.has(c.name))]);
  }

  /**
   * Start servers in parallel. Returns a promise that resolves when every connect attempt settled;
   * callers must NOT await it before the first model turn (never block turn 1).
   */
  start(configs: McpServerConfig[]): Promise<void> {
    const ps = configs.map((c) => this.startOne(c));
    const all = Promise.all(ps).then(() => {});
    this.pendingStarts.push(all);
    return all;
  }

  /** Resolves when all startups so far settled (tests, shutdown). */
  async settled(): Promise<void> { await Promise.all(this.pendingStarts); }

  private emit(e: Entry) { this.o.onStatusChanged?.(this.info(e)); }
  private set(e: Entry, status: McpStatus, error?: string) { e.status = status; e.error = error; this.emit(e); }

  private async startOne(cfg: McpServerConfig): Promise<void> {
    const prev = this.entries.get(cfg.name);
    if (prev) await this.stopEntry(prev);
    const e: Entry = { cfg, status: cfg.disabled ? "disabled" : "connecting", defs: [], drops: 0, epoch: (prev?.epoch ?? 0) + 1 };
    this.entries.set(cfg.name, e);
    this.emit(e);
    if (cfg.disabled) return;
    await this.connect(e);
  }

  private async connect(e: Entry): Promise<void> {
    const epoch = e.epoch;
    const client = this.o.clientCtor ? this.o.clientCtor(e.cfg, this.o.cwd) : new McpClient(e.cfg, { cwd: this.o.cwd });
    try {
      await client.connect(this.o.connectTimeoutMs ?? 30000);
      const defs = await client.listTools(this.o.connectTimeoutMs ?? 30000);
      if (e.epoch !== epoch) { void client.close(); return; }
      e.client = client; e.defs = defs;
      e.requiresAuth = false;
      client.onClose = (reason) => this.onDrop(e, epoch, reason);
      this.set(e, "connected");
    } catch (err) {
      void client.close().catch(() => {});
      if (e.epoch !== epoch) return;
      e.defs = [];
      e.requiresAuth = err instanceof McpAuthRequired;
      this.set(e, "failed", (err as Error).message);
    }
  }

  private onDrop(e: Entry, epoch: number, reason: string) {
    if (e.epoch !== epoch) return;
    e.drops++;
    e.client = undefined; e.defs = [];
    const max = this.o.maxDrops ?? MAX_DROPS;
    if (e.drops >= max) {
      this.set(e, "failed", `suppressed: connected and dropped ${e.drops} times (last: ${reason})`);
      return;
    }
    this.set(e, "disconnected", reason);
    e.reconnectTimer = setTimeout(() => {
      if (e.epoch !== epoch) return;
      this.set(e, "connecting");
      void this.connect(e);
    }, this.o.reconnectDelayMs ?? 1000);
  }

  private async stopEntry(e: Entry) {
    e.epoch++;
    if (e.reconnectTimer) clearTimeout(e.reconnectTimer);
    const c = e.client; e.client = undefined; e.defs = [];
    if (c) { c.onClose = undefined; await c.close().catch(() => {}); }
  }

  // ---------------------------------------------------------------- status (list_mcp_servers)
  private info(e: Entry): McpServerStatusInfo {
    const i: McpServerStatusInfo = {
      name: e.cfg.name, status: e.status, source: e.cfg.source, isManaged: false, serverType: e.cfg.type,
    };
    if (e.error) i.error = e.error;
    if (e.cfg.type !== "stdio") { i.requiresAuth = !!e.requiresAuth; i.hasAuthTokens = hasMcpTokens(e.cfg); }
    if (e.status === "connected") i.toolCount = e.defs.length;
    return i;
  }

  /** Result of `list_mcp_servers`. */
  listServers(): { servers: McpServerStatusInfo[]; summary: McpStatusSummary } {
    const servers = [...this.entries.values()].map((e) => this.info(e));
    const count = (s: McpStatus) => servers.filter((x) => x.status === s).length;
    const summary: McpStatusSummary = {
      total: servers.length, connected: count("connected"), connecting: count("connecting"), failed: count("failed"),
      disabled: count("disabled"),
    };
    if (this.configError) summary.configError = this.configError;
    return { servers, summary };
  }

  // ---------------------------------------------------------------- tools
  /** Tools of connected servers (suppressed/failed servers contribute none). */
  tools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const e of this.entries.values()) {
      if (e.status !== "connected") continue;
      for (const d of e.defs) {
        out.push({
          server: e.cfg.name, tool: d.name, llmName: mcpLlmName(e.cfg.name, d.name), bindingName: mcpBindingName(e.cfg.name, d.name),
          description: d.description ?? "", inputSchema: (d.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        });
      }
    }
    return out;
  }

  findTool(llmNameOrBinding: string): McpToolInfo | undefined {
    return this.tools().find((t) => t.llmName === llmNameOrBinding || t.bindingName === llmNameOrBinding);
  }

  /** Call by `server__tool` or `server.tool`. Throws when unknown or the server is not connected. */
  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const t = this.findTool(name);
    if (!t) throw new Error(`MCP tool not available: ${name}`);
    const e = this.entries.get(t.server);
    if (!e?.client || e.status !== "connected") throw new Error(`MCP server "${t.server}" is not connected`);
    try { return await e.client.callTool(t.tool, args, opts); }
    catch (err) {
      if (err instanceof McpAuthRequired) {
        await this.stopEntry(e); e.requiresAuth = true; this.set(e, "failed", err.message);
      }
      throw err;
    }
  }

  private named(name: string) {
    const e = this.entries.get(name);
    if (!e) throw new Error("Unknown MCP server");
    return e;
  }

  async signIn(name: string) {
    const e = this.named(name);
    if (e.cfg.disabled) throw new Error("This MCP server is disabled");
    const epoch = e.epoch;
    const st = await signInMcp(e.cfg);
    if (this.entries.get(name) !== e || e.epoch !== epoch) { authManager().cancelLogin(st.loginId); throw new Error("MCP server changed during sign-in"); }
    this.logins.set(st.loginId, name);
    void authManager().waitLogin(st.loginId).then(async (done) => {
      if (done.state !== "complete" || this.entries.get(name) !== e || e.epoch !== epoch) return;
      await this.stopEntry(e); this.set(e, "connecting"); await this.connect(e);
    }).catch(() => {});
    return { ...st, name };
  }

  loginStatus(name: string, loginId: string) {
    this.named(name);
    if (this.logins.get(loginId) !== name) throw new Error("Unknown MCP login");
    const st = authManager().loginStatus(loginId);
    if (!st) throw new Error("Unknown MCP login");
    return { ...st, name };
  }

  cancelLogin(name: string, loginId: string) {
    this.loginStatus(name, loginId);
    return { cancelled: authManager().cancelLogin(loginId) };
  }

  async signOut(name: string) {
    const e = this.named(name);
    if (e.cfg.type === "stdio") throw new Error("OAuth is unavailable for this MCP server");
    await this.stopEntry(e);
    const loggedOut = signOutMcp(e.cfg);
    e.requiresAuth = true;
    this.set(e, "disconnected", "Signed out");
    return { loggedOut };
  }

  // ---------------------------------------------------------------- add / remove
  listCatalog(sources?: unknown) { return this.catalog.list(sources); }
  async addCatalog(key: string, values?: Record<string, string>, name?: string) {
    const cfg = this.catalog.prepare(key, values, name, (n) => this.entries.has(n) || loadMcpConfig({ cwd: this.o.cwd ?? process.cwd(), trustProject: this.o.projectTrusted }).servers.some((s) => s.name === n));
    await this.addServer(cfg);
    const login = cfg.oauth ? await this.signIn(cfg.name) : undefined;
    return { name: cfg.name, login };
  }
  /** add_mcp_server: validate, persist to the user mcp.json, start it. */
  async addServer(p: AddMcpServerParams): Promise<{ success: boolean }> {
    const cfg = fromAddParams(p);
    saveUserServer(cfg);
    await this.start([cfg]);
    return { success: true };
  }

  /** remove_mcp_server (settingsLevel "user"): stop it and drop it from the user mcp.json. */
  async removeServer(serverName: string, settingsLevel: "user" = "user"): Promise<{ success: boolean }> {
    if (settingsLevel !== "user") throw new Error('only settingsLevel "user" is supported');
    const e = this.entries.get(serverName);
    for (const [id, name] of this.logins) if (name === serverName) { authManager().cancelLogin(id); this.logins.delete(id); }
    const existed = removeUserServer(serverName);
    if (e) { await this.stopEntry(e); this.entries.delete(serverName); }
    return { success: existed || !!e };
  }

  async shutdown(): Promise<void> {
    for (const id of this.logins.keys()) authManager().cancelLogin(id);
    this.logins.clear();
    await Promise.all([...this.entries.values()].map((e) => this.stopEntry(e)));
    this.entries.clear();
  }
}
