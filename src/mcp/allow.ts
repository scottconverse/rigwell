// "Always allow" memory for MCP tools (spec 5.5.5): a tool, or every tool of a server, saved in the user settings.
// Shape in settings.json: "mcpAlwaysAllow": { "tools": { "<server>__<tool>": "<impact level>" }, "servers": ["<server>"] }.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "../storage/settings.ts";
import { rigwellHome } from "../storage/paths.ts";
import type { McpToolInfo } from "./types.ts";

interface AlwaysAllow { tools?: Record<string, string>; servers?: string[] }

/** True when the settings remember this tool or its server. */
export function isMcpAllowed(cwd: string, t: Pick<McpToolInfo, "llmName" | "server">): boolean {
  const a = (loadSettings({ cwd }).settings.mcpAlwaysAllow ?? {}) as AlwaysAllow;
  return !!(a.tools && t.llmName in a.tools) || !!a.servers?.includes(t.server);
}

function userSettingsFile() { return path.join(rigwellHome(), "settings.json"); }

/** Saves the choice in the user settings.json, keeping every other key. */
export function rememberMcp(kind: "tool" | "server", t: Pick<McpToolInfo, "llmName" | "server">, impact = "high"): void {
  const file = userSettingsFile();
  let cur: Record<string, any> = {};
  try { const j = JSON.parse(readFileSync(file, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) cur = j; } catch { /* new file */ }
  const a: AlwaysAllow = { tools: { ...(cur.mcpAlwaysAllow?.tools ?? {}) }, servers: [...(cur.mcpAlwaysAllow?.servers ?? [])] };
  if (kind === "tool") a.tools![t.llmName] = impact;
  else if (!a.servers!.includes(t.server)) a.servers!.push(t.server);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...cur, mcpAlwaysAllow: a }, null, 2) + "\n");
  renameSync(tmp, file);
}
