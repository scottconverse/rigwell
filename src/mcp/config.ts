// MCP server config: mcp.json at user ($RIGWELL_HOME) and project (.rigwell/) levels, plus
// initialize_session `mcpServers` and add/remove (spec §12.2, §3.1.5, §3.1.6).
// mcp.json format: { "mcpServers": { "<name>": { type?, command, args, env, url, headers, disabled } } } (a bare map also works).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDirs, readJsonObject } from "../config/levels.ts";
import { rigwellHome } from "../storage/paths.ts";
import type { AddMcpServerParams, McpServerConfig, McpServerInitConfig, McpSource } from "./types.ts";

const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") o[k] = x;
  return o;
};

/** Normalize one mcp.json entry; null when unusable. */
export function normalizeServer(name: string, raw: unknown, source: McpSource): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const type = r.type === "http" || r.type === "sse" || r.type === "stdio" ? r.type
    : typeof r.url === "string" ? "http" : "stdio";
  const c: McpServerConfig = { name, type, source };
  if (type === "stdio") {
    if (typeof r.command !== "string" || !r.command) return null;
    c.command = r.command;
    c.args = Array.isArray(r.args) ? r.args.filter((a: unknown): a is string => typeof a === "string") : [];
    c.env = strMap(r.env) ?? {};
  } else {
    if (typeof r.url !== "string" || !r.url) return null;
    c.url = r.url;
    c.headers = Array.isArray(r.headers)
      ? Object.fromEntries(r.headers.filter((h: any) => h && typeof h.name === "string").map((h: any) => [h.name, String(h.value ?? "")]))
      : (strMap(r.headers) ?? {});
    if (r.oauth !== undefined) c.oauth = r.oauth;
  }
  if (r.disabled === true) c.disabled = true;
  return c;
}

export interface LoadedMcpConfig { servers: McpServerConfig[]; warnings: string[]; configError?: { path: string; message: string } }

/** Load mcp.json from folder/project/user levels; the higher level wins on a name clash. */
export function loadMcpConfig(opts: { cwd: string; homeDir?: string }): LoadedMcpConfig {
  const warnings: string[] = [];
  const byName = new Map<string, McpServerConfig>();
  let configError: LoadedMcpConfig["configError"];
  for (const { level, dir } of configDirs(opts.cwd, opts.homeDir)) {
    const file = path.join(dir, "mcp.json");
    const f = readJsonObject(file);
    if (f.warning) { warnings.push(f.warning); configError ??= { path: file, message: f.warning }; }
    if (!f.value) continue;
    const map = (f.value.mcpServers && typeof f.value.mcpServers === "object" ? f.value.mcpServers : f.value) as Record<string, unknown>;
    for (const [name, raw] of Object.entries(map)) {
      if (byName.has(name)) continue;
      const c = normalizeServer(name, raw, level);
      if (c) byName.set(name, c); else warnings.push(`${file}: server "${name}" is invalid, ignored`);
    }
  }
  return { servers: [...byName.values()], warnings, configError };
}

/** Convert initialize_session / load_session `mcpServers` entries. */
export function fromInitConfigs(list: McpServerInitConfig[] | undefined): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const e of list ?? []) {
    const c = normalizeServer((e as any).name, { ...(e as object), type: (e as any).type ?? "stdio" }, "session");
    if (c) out.push(c);
  }
  return out;
}

export function fromAddParams(p: AddMcpServerParams): McpServerConfig {
  if (!p.name || typeof p.name !== "string") throw new Error("name is required");
  const c = normalizeServer(p.name, p, "user");
  if (!c) throw new Error(p.type === "stdio" ? "command is required for a stdio server" : "url is required for an http/sse server");
  return c;
}

function writeUserFile(file: string, obj: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, file);
}

function serialize(c: McpServerConfig): Record<string, unknown> {
  const o: Record<string, unknown> = { type: c.type };
  if (c.type === "stdio") { o.command = c.command; o.args = c.args ?? []; if (c.env && Object.keys(c.env).length) o.env = c.env; }
  else { o.url = c.url; if (c.headers && Object.keys(c.headers).length) o.headers = c.headers; if (c.oauth !== undefined) o.oauth = c.oauth; }
  if (c.disabled) o.disabled = true;
  return o;
}

/** Persist a server in the user-level mcp.json (add_mcp_server). */
export function saveUserServer(c: McpServerConfig): void {
  const file = path.join(rigwellHome(), "mcp.json");
  const cur = readJsonObject(file).value ?? {};
  const servers = { ...((cur.mcpServers as Record<string, unknown>) ?? {}), [c.name]: serialize(c) };
  writeUserFile(file, { ...cur, mcpServers: servers });
}

/** Remove a server from the user-level mcp.json (remove_mcp_server, settingsLevel "user"). Returns whether it existed. */
export function removeUserServer(name: string): boolean {
  const file = path.join(rigwellHome(), "mcp.json");
  const cur = readJsonObject(file).value;
  const servers = cur?.mcpServers as Record<string, unknown> | undefined;
  if (!cur || !servers || !(name in servers)) return false;
  const { [name]: _gone, ...rest } = servers;
  writeUserFile(file, { ...cur, mcpServers: rest });
  return true;
}
