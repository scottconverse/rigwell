// Custom slash commands and skills in the "/" menu (spec §12.2 lists a `commands/` folder; the file format is not given).
// Rigwell format: Markdown files, one command per file.
//   Project: <project root>/.rigwell/commands/<name>.md      User: $RIGWELL_HOME/commands/<name>.md
//   The file name (without .md, lower-cased) is the command name; the project file wins over the user file.
//   Optional frontmatter: `description`, `argument-hint`. The body is the prompt sent to the model.
//   In the body, $ARGUMENTS is replaced with everything typed after the command; $1..$9 with the n-th word.
//   When the body has no placeholder and arguments are typed, they are appended after a blank line.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../config/frontmatter.ts";
import { projectRoot } from "../config/levels.ts";
import { SkillRegistry } from "../skills/index.ts";
import { rigwellHome } from "../storage/paths.ts";
import { COMMANDS } from "./commands.ts";
import type { CustomEntry } from "./types.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function scan(dir: string, origin: string): CustomEntry[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: CustomEntry[] = [];
  for (const f of names.sort()) {
    if (!f.endsWith(".md")) continue;
    const name = f.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) continue;
    const file = path.join(dir, f);
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(text);
    const d = fm.data ?? {};
    const body = fm.body.trim();
    if (!body) continue;
    const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 80) ?? "";
    out.push({
      name, kind: "command", body, filePath: file, origin,
      desc: typeof d.description === "string" && d.description ? d.description : firstLine,
      argHint: typeof d["argument-hint"] === "string" ? (d["argument-hint"] as string) : undefined,
    });
  }
  return out;
}

export function loadCustomCommands(cwd: string, homeDir?: string): CustomEntry[] {
  const root = projectRoot(cwd, homeDir);
  return [...(root ? scan(path.join(root, ".rigwell", "commands"), "project") : []), ...scan(path.join(rigwellHome(), "commands"), "user")];
}

/** Custom commands plus user-invocable skills, minus anything that clashes with a built-in command or an earlier entry. */
export function loadCustomEntries(cwd: string, homeDir?: string): { entries: CustomEntry[]; skills: number } {
  const reg = new SkillRegistry({ cwd, homeDir }).load();
  const enabled = reg.enabled();
  const taken = new Set<string>(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const entries: CustomEntry[] = [];
  const add = (e: CustomEntry) => { if (!taken.has(e.name)) { taken.add(e.name); entries.push(e); } };
  for (const c of loadCustomCommands(cwd, homeDir)) add(c);
  for (const s of enabled) {
    if (s.userInvocable) add({ name: s.name, kind: "skill", desc: s.description, body: s.body, filePath: s.filePath, origin: s.bucket });
  }
  return { entries, skills: enabled.length };
}

/** The prompt sent to the model for `/name args`. */
export function expandEntry(e: CustomEntry, args: string): string {
  if (e.kind === "skill") {
    return `Skill "${e.name}" was invoked by the user. Follow its instructions for this task.\n<skill name="${e.name}" filePath="${e.filePath ?? ""}">\n${e.body}${args ? `\n\nArguments: ${args}` : ""}\n</skill>`;
  }
  const words = args.split(/\s+/).filter(Boolean);
  let used = false;
  let out = e.body.replace(/\$ARGUMENTS|\$([1-9])/g, (_m, n) => { used = true; return n ? words[Number(n) - 1] ?? "" : args; });
  if (!used && args) out += `\n\n${args}`;
  return out;
}

// ---------------------------------------------------------------- /loop (spec §16.6)

export type LoopCommand =
  | { kind: "list" }
  | { kind: "stop"; id: string }
  | { kind: "create"; interval: string; prompt: string }
  | { kind: "error"; message: string };

/** `/loop 30m <prompt>`, `/loop <prompt> every 2h`, `/loop stop [id|all]`, `/loop list`. An empty prompt means loop.md (the app reads it). */
export function parseLoop(args: string): LoopCommand {
  const a = args.trim();
  if (a === "list") return { kind: "list" };
  const stop = /^stop(?:\s+(\S+))?$/.exec(a);
  if (stop) return { kind: "stop", id: stop[1] ?? "all" };
  const lead = /^(\d+\s*[mh])(?:\s+([\s\S]*))?$/i.exec(a);
  if (lead) return { kind: "create", interval: lead[1].replace(/\s+/g, "").toLowerCase(), prompt: (lead[2] ?? "").trim() };
  const trail = /^([\s\S]*?)\s+every\s+(\d+\s*[mh])$/i.exec(a);
  if (trail) return { kind: "create", interval: trail[2].replace(/\s+/g, "").toLowerCase(), prompt: trail[1].trim() };
  return { kind: "error", message: "Usage: /loop <30m|2h> <prompt> | /loop <prompt> every <2h> | /loop list | /loop stop [id|all]" };
}
