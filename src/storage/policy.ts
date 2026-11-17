// Local policy (spec 20.20). Never load authority from the working repository.
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AutonomyLevel } from "../core/types.ts";
import type { ModelPolicy } from "./org.ts";
import type { McpServerConfig } from "../mcp/types.ts";

export interface Policy {
  schemaVersion: 1;
  modelPolicy?: ModelPolicy;
  maxAutonomyLevel?: AutonomyLevel;
  missions?: { enabled?: boolean; maxConcurrentRuns?: number; maxFeatures?: number; maxWorkerAttempts?: number };
  workstreams?: { enabled?: boolean; maxActive?: number; maxMembers?: number; maxConcurrentAgents?: number; allowNestedSpawn?: boolean };
  /** Exact launch descriptors, not names that project configuration could redirect. */
  mcpServerAllowlist?: McpLaunch[];
  requiredHooks?: Record<string, { matcher?: string; commandRegex?: string; hooks: { type: "command"; command: string; timeout?: number }[] }[]>;
}
type McpLaunch = Pick<McpServerConfig, "name" | "type" | "command" | "args" | "env" | "url">;
const plain = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const ranks = ["off", "low", "medium", "high"];
const events = ["PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd"];
const keys = (v: any, allowed: string[]) => { if (!plain(v) || Object.keys(v).some((k) => !allowed.includes(k))) throw new Error("Unknown policy field or invalid object"); };
const list = (v: any) => Array.isArray(v) && v.every((s) => typeof s === "string" && !!s.trim());

export function validatePolicy(v: unknown): Policy {
  keys(v, ["schemaVersion", "modelPolicy", "maxAutonomyLevel", "missions", "workstreams", "mcpServerAllowlist", "requiredHooks"]);
  const p = v as Policy;
  if (p.schemaVersion !== 1) throw new Error("Policy schemaVersion must be 1");
  if (p.maxAutonomyLevel !== undefined && !ranks.includes(p.maxAutonomyLevel)) throw new Error("Invalid policy maxAutonomyLevel");
  if (p.modelPolicy !== undefined) {
    keys(p.modelPolicy, ["allowedModelIds", "blockedModelIds", "allowCustomModels"]);
    for (const k of ["allowedModelIds", "blockedModelIds"] as const) if (p.modelPolicy[k] !== undefined && !list(p.modelPolicy[k])) throw new Error(`Invalid policy ${k}`);
    if (p.modelPolicy.allowCustomModels !== undefined && typeof p.modelPolicy.allowCustomModels !== "boolean") throw new Error("Invalid policy allowCustomModels");
  }
  for (const [section, allowed] of [["missions", ["enabled", "maxConcurrentRuns", "maxFeatures", "maxWorkerAttempts"]], ["workstreams", ["enabled", "maxActive", "maxMembers", "maxConcurrentAgents", "allowNestedSpawn"]]] as const) {
    const limits = p[section]; if (limits === undefined) continue;
    keys(limits, [...allowed]);
    for (const [k, n] of Object.entries(limits)) if (["enabled", "allowNestedSpawn"].includes(k) ? typeof n !== "boolean" : !Number.isSafeInteger(n) || (n as number) < 0) throw new Error(`Invalid policy ${section}.${k}`);
  }
  if (p.mcpServerAllowlist !== undefined) {
    if (!Array.isArray(p.mcpServerAllowlist)) throw new Error("Invalid policy mcpServerAllowlist");
    for (const s of p.mcpServerAllowlist) {
      keys(s, ["name", "type", "command", "args", "env", "url"]);
      if (typeof s.name !== "string" || !s.name || !["stdio", "http", "sse"].includes(s.type)) throw new Error("Invalid policy MCP identity");
      if (s.type === "stdio") {
        if (typeof s.command !== "string" || !s.command || s.url !== undefined || (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) || (s.env !== undefined && (!plain(s.env) || Object.values(s.env).some((x) => typeof x !== "string")))) throw new Error("Invalid policy MCP launch");
      } else if (typeof s.url !== "string" || !/^https?:\/\/\S+$/.test(s.url) || [s.command, s.args, s.env].some((x) => x !== undefined)) throw new Error("Invalid policy MCP endpoint");
    }
  }
  if (p.requiredHooks !== undefined) {
    keys(p.requiredHooks, events);
    for (const groups of Object.values(p.requiredHooks)) {
      if (!Array.isArray(groups) || !groups.length) throw new Error("Invalid required hook groups");
      for (const g of groups) {
        keys(g, ["matcher", "commandRegex", "hooks"]);
        if ([g.matcher, g.commandRegex].some((x) => x !== undefined && typeof x !== "string") || !Array.isArray(g.hooks) || !g.hooks.length) throw new Error("Invalid required hook group");
        if (g.commandRegex) new RegExp(g.commandRegex);
        for (const h of g.hooks) {
          keys(h, ["type", "command", "timeout"]);
          if (h.type !== "command" || typeof h.command !== "string" || !h.command.trim() || (h.timeout !== undefined && (!Number.isFinite(h.timeout) || h.timeout <= 0))) throw new Error("Invalid required hook command");
        }
      }
    }
  }
  return p;
}

export function policyPaths(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform) {
  const home = env.RIGWELL_HOME ? path.resolve(env.RIGWELL_HOME) : path.join(env.HOME || env.USERPROFILE || homedir(), ".rigwell");
  const system = platform === "win32" ? path.join(env.ProgramData || "C:\\ProgramData", "Rigwell", "policy.json") : platform === "darwin" ? "/Library/Application Support/Rigwell/policy.json" : "/etc/rigwell/policy.json";
  return [...new Set([...(env.RIGWELL_PROFILE_ROOT ? [path.join(path.resolve(env.RIGWELL_PROFILE_ROOT), "policy.json")] : []), path.join(home, "policy.json"), system])];
}

/** Read local then system policy. Missing files are optional; unusable present files fail closed. */
export function loadPolicies(env: Record<string, string | undefined> = process.env, paths = policyPaths(env)): { path: string; policy: Policy }[] {
  return paths.flatMap((file) => {
    let st; try { st = lstatSync(file); } catch (e: any) { if (e.code === "ENOENT") return []; throw new Error(`Cannot read policy ${file}: ${e.code ?? "filesystem error"}`); }
    try {
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw new Error("Policy must be an unlinked regular file of at most 1 MiB");
      return [{ path: file, policy: validatePolicy(JSON.parse(readFileSync(file, "utf8"))) }];
    } catch (e) { throw new Error(`Invalid policy ${file}: ${(e as Error).message}`); }
  });
}

export function effectivePolicy(env: Record<string, string | undefined> = process.env, loaded = loadPolicies(env)): Policy {
  const all = loaded.map((p) => p.policy), out: Policy = { schemaVersion: 1 };
  for (const p of all) {
    if (p.maxAutonomyLevel !== undefined) out.maxAutonomyLevel = ranks[Math.min(ranks.indexOf(out.maxAutonomyLevel ?? "high"), ranks.indexOf(p.maxAutonomyLevel))] as AutonomyLevel;
    if (p.modelPolicy) {
      const a = out.modelPolicy ?? {}, b = p.modelPolicy;
      out.modelPolicy = { ...a, ...b, ...(a.allowedModelIds && b.allowedModelIds ? { allowedModelIds: a.allowedModelIds.filter((id) => b.allowedModelIds!.includes(id)) } : {}), blockedModelIds: [...new Set([...(a.blockedModelIds ?? []), ...(b.blockedModelIds ?? [])])], ...(a.allowCustomModels === false || b.allowCustomModels === false ? { allowCustomModels: false } : {}) };
    }
    for (const section of ["missions", "workstreams"] as const) if (p[section]) {
      const limits: Record<string, unknown> = { ...out[section] };
      for (const [k, n] of Object.entries(p[section]!)) limits[k] = typeof n === "number" ? Math.min(typeof limits[k] === "number" ? limits[k] as number : Infinity, n) : limits[k] === false || n === false ? false : true;
      out[section] = limits;
    }
    if (p.requiredHooks) { out.requiredHooks ??= {}; for (const [ev, groups] of Object.entries(p.requiredHooks)) out.requiredHooks[ev] = [...groups, ...(out.requiredHooks[ev] ?? [])]; }
    if (p.mcpServerAllowlist) out.mcpServerAllowlist = out.mcpServerAllowlist ? out.mcpServerAllowlist.filter((c) => p.mcpServerAllowlist!.some((s) => sameLaunch(c, s))) : p.mcpServerAllowlist;
  }
  return out;
}
function sameLaunch(a: McpLaunch, b: McpLaunch) {
  const env = (s: McpLaunch) => JSON.stringify(Object.entries(s.env ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return a.name === b.name && a.type === b.type && (a.type === "stdio" ? a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []) && env(a) === env(b) : a.url === b.url);
}
export function assertMcpPolicy(cfg: McpServerConfig) {
  const list = effectivePolicy().mcpServerAllowlist;
  if (list && !list.some((s) => sameLaunch(cfg, s))) throw new Error(`MCP server ${cfg.name} is blocked by policy`);
}
