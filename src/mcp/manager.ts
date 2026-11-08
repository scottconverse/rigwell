// MCP manager: parallel server startup, status tracking, tool naming, drop suppression (spec §5.7, §6.2).
import { McpClient } from "./client.ts";
import { fromAddParams, loadMcpConfig, removeUserServer, saveUserServer } from "./config.ts";
import { authManager, type LoginStatus } from "../auth/oauth.ts";
import { McpAuthRequiredError, mcpHasToken, mcpLoginStart, mcpLogout, oauthEnabled } from "./oauth.ts";
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
  client?: McpClient;
  defs: McpToolDef[];
  drops: number;
  /** Bumped on remove/restart so stale async work is ignored. */
  epoch: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /** The last connect failed with a 401: the user must sign in. */
  needsAuth?: boolean;
  /** WWW-Authenticate of that 401 (points discovery at the resource metadata). */
  wwwAuthenticate?: string;
  /** A sign-in token is stored (read once per connect, not per status call). */
  hasToken?: boolean;
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
  private entries = new Map<string, Entry>();
  private pendingStarts: Promise<unknown>[] = [];
  /** Flattened tool list and lookup maps, rebuilt only after a server's tools or status changed (listToolInfo asks per tool). */
  private toolCache?: { list: McpToolInfo[]; byName: Map<string, McpToolInfo> };
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
  private set(e: Entry, status: McpStatus, error?: string) { e.status = status; e.error = error; this.toolCache = undefined; this.emit(e); }

  private async startOne(cfg: McpServerConfig): Promise<void> {
    const prev = this.entries.get(cfg.name);
    if (prev) await this.stopEntry(prev);
    const e: Entry = { cfg, status: cfg.disabled ? "disabled" : "connecting", defs: [], drops: 0, epoch: (prev?.epoch ?? 0) + 1 };
    this.entries.set(cfg.name, e);
    this.toolCache = undefined;
    this.emit(e);
    if (cfg.disabled) return;
    await this.connect(e);
  }

  private async connect(e: Entry): Promise<void> {
    const epoch = e.epoch;
    const client = this.o.clientCtor ? this.o.clientCtor(e.cfg, this.o.cwd) : new McpClient(e.cfg, { cwd: this.o.cwd });
    e.hasToken = oauthEnabled(e.cfg) ? mcpHasToken(e.cfg) : undefined;
    try {
      await client.connect(this.o.connectTimeoutMs ?? 30000);
      const defs = await client.listTools(this.o.connectTimeoutMs ?? 30000);
      if (e.epoch !== epoch) { void client.close(); return; }
      e.client = client; e.defs = defs; e.needsAuth = false; e.wwwAuthenticate = undefined;
      client.onClose = (reason) => this.onDrop(e, epoch, reason);
      this.set(e, "connected");
    } catch (err) {
      void client.close().catch(() => {});
      if (e.epoch !== epoch) return;
      e.defs = [];
      e.needsAuth = err instanceof McpAuthRequiredError;
      e.wwwAuthenticate = err instanceof McpAuthRequiredError ? err.wwwAuthenticate : undefined;
      this.set(e, "failed", (err as Error).message);
    }
  }

  private onDrop(e: Entry, epoch: number, reason: string) {
    if (e.epoch !== epoch) return;
    e.drops++;
    e.client = undefined; e.defs = [];
    this.toolCache = undefined;
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
    this.toolCache = undefined;
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
    if (e.status === "connected") i.toolCount = e.defs.length;
    if (oauthEnabled(e.cfg)) { i.requiresAuth = !!e.needsAuth; i.hasAuthTokens = !!e.hasToken; }
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
  tools(): McpToolInfo[] { return [...this.toolIndex().list]; }

  private toolIndex(): { list: McpToolInfo[]; byName: Map<string, McpToolInfo> } {
    if (this.toolCache) return this.toolCache;
    const list: McpToolInfo[] = [];
    const byName = new Map<string, McpToolInfo>();
    for (const e of this.entries.values()) {
      if (e.status !== "connected") continue;
      for (const d of e.defs) {
        const info: McpToolInfo = {
          server: e.cfg.name, tool: d.name, llmName: mcpLlmName(e.cfg.name, d.name), bindingName: mcpBindingName(e.cfg.name, d.name),
          description: d.description ?? "", inputSchema: (d.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        };
        list.push(info);
      }
    }
    // First tool wins for each spelling, so a lookup returns what a linear find over the list would.
    for (const t of list) {
      if (!byName.has(t.llmName)) byName.set(t.llmName, t);
      if (!byName.has(t.bindingName)) byName.set(t.bindingName, t);
    }
    return (this.toolCache = { list, byName });
  }

  findTool(llmNameOrBinding: string): McpToolInfo | undefined {
    return this.toolIndex().byName.get(llmNameOrBinding);
  }

  /** Call by `server__tool` or `server.tool`. Throws when unknown or the server is not connected. */
  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const t = this.findTool(name);
    if (!t) throw new Error(`MCP tool not available: ${name}`);
    const e = this.entries.get(t.server);
    if (!e?.client || e.status !== "connected") throw new Error(`MCP server "${t.server}" is not connected`);
    return e.client.callTool(t.tool, args, opts);
  }

  // ---------------------------------------------------------------- add / remove
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
    const existed = removeUserServer(serverName);
    if (e) { await this.stopEntry(e); this.entries.delete(serverName); }
    return { success: existed || !!e };
  }

  // ---------------------------------------------------------------- OAuth sign-in (mcp_auth_start, mcp_auth_logout)
  /** Start the browser sign-in for a server. When it completes, the server reconnects with the new token. */
  async login(serverName: string): Promise<LoginStatus> {
    const e = this.entries.get(serverName);
    if (!e) throw new Error(`No MCP server named ${JSON.stringify(serverName)}`);
    const st = await mcpLoginStart(e.cfg, { wwwAuthenticate: e.wwwAuthenticate });
    void authManager().waitLogin(st.loginId).then((end) => {
      if (end.state === "complete" && this.entries.get(serverName) === e) void this.startOne(e.cfg);
    }).catch(() => {});
    return st;
  }

  /** Remove the stored sign-in and reconnect (the server then reports that sign-in is needed). */
  async logout(serverName: string): Promise<{ success: boolean }> {
    const e = this.entries.get(serverName);
    const removed = mcpLogout(serverName);
    if (e && !e.cfg.disabled) await this.startOne(e.cfg);
    return { success: removed };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.stopEntry(e)));
    this.entries.clear();
  }
}
