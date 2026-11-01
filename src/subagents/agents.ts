// Custom subagent files (spec §5.9 and §12.2 "Custom subagents"; folder renamed for Rigwell).
// Folder name: `agents`. Personal: `$RIGWELL_HOME/agents/<name>.md`. Project: `<project root>/.rigwell/agents/<name>.md`.
// Project agents are read before personal ones; the first file found for a normalized name wins.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeName, parseFrontmatter, toStringList } from "../config/frontmatter.ts";
import { projectRoot } from "../config/levels.ts";
import { rigwellHome } from "../storage/paths.ts";
import type { ReasoningEffort } from "../core/types.ts";

export interface CustomAgent {
  /** Normalized name; the id used as the Task `agent` value. */
  name: string;
  /** Name as written (or the file base name). */
  displayName: string;
  description: string;
  /** `inherit` = the parent's model. */
  model: string;
  reasoningEffort?: ReasoningEffort | string;
  /** Allow-list; undefined = all allowed tools. */
  tools?: string[];
  mcpServers?: string[];
  /** The markdown body: the subagent's system prompt. */
  systemPrompt: string;
  location: "project" | "personal";
  filePath: string;
  mtimeMs: number;
}

export function parseAgentFile(filePath: string, text: string, location: "project" | "personal", mtimeMs = 0): CustomAgent | null {
  const fm = parseFrontmatter(text);
  const d = fm.data ?? {}; // invalid frontmatter is treated as empty; the file still loads
  const base = path.basename(filePath).replace(/\.md$/i, "");
  const rawName = typeof d.name === "string" && d.name.trim() ? d.name.trim() : base;
  const name = normalizeName(rawName);
  if (!name) return null;
  return {
    name, displayName: rawName,
    description: typeof d.description === "string" ? d.description.trim() : "",
    model: typeof d.model === "string" && d.model.trim() ? d.model.trim() : "inherit",
    reasoningEffort: typeof d.reasoningEffort === "string" ? d.reasoningEffort : undefined,
    tools: toStringList(d.tools),
    mcpServers: toStringList(d.mcpServers),
    systemPrompt: fm.body.trim(), location, filePath, mtimeMs,
  };
}

function scan(dir: string, location: "project" | "personal"): CustomAgent[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort(); } catch { return []; }
  const out: CustomAgent[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      const a = parseAgentFile(file, readFileSync(file, "utf8"), location, st.mtimeMs);
      if (a) out.push(a);
    } catch { /* unreadable */ }
  }
  return out;
}

export interface LoadAgentsOptions {
  cwd: string;
  homeDir?: string;
  /** Returns whether a model id is valid; an invalid agent model falls back to `inherit`. */
  isValidModel?: (id: string) => boolean;
}

export interface LoadedAgents { agents: CustomAgent[]; shadowed: CustomAgent[] }

/** Project agents first, then personal; first found per normalized name wins (the rest are listed as `shadowed`). */
export function loadAgents(o: LoadAgentsOptions): LoadedAgents {
  const root = projectRoot(o.cwd, o.homeDir);
  const found = [...(root ? scan(path.join(root, ".rigwell", "agents"), "project") : []), ...scan(path.join(rigwellHome(), "agents"), "personal")];
  const seen = new Set<string>();
  const agents: CustomAgent[] = [], shadowed: CustomAgent[] = [];
  for (const a of found) {
    if (o.isValidModel && a.model !== "inherit" && !o.isValidModel(a.model)) a.model = "inherit";
    if (seen.has(a.name)) shadowed.push(a); else { seen.add(a.name); agents.push(a); }
  }
  return { agents, shadowed };
}

/** Lines for the Task catalog (`name: description`). */
export function agentCatalog(agents: CustomAgent[]): string[] {
  return agents.map((a) => `${a.name}: ${a.description || "(no description)"}`);
}
