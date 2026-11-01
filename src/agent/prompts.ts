// Builds system blocks and first-message context blocks from spec/prompts.md text.
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";
import type { AutonomyLevel, InteractionMode } from "../core/types.ts";

export const AGENT_NAME = "Rigwell";

type Vars = Record<string, unknown>;

/** Minimal Handlebars-style renderer: {{X}}, {{#if X}}..{{else}}..{{/if}}, {{#each X}}..{{/each}} (nestable). */
export function render(tpl: string, vars: Vars): string {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf("{{", i);
    if (open < 0) { out += tpl.slice(i); break; }
    out += tpl.slice(i, open);
    const close = tpl.indexOf("}}", open);
    const tag = tpl.slice(open + 2, close).trim();
    i = close + 2;
    const m = /^#(if|each)\s+(\w+)$/.exec(tag);
    if (!m) { out += String(vars[tag] ?? ""); continue; }
    const [kind, name] = [m[1], m[2]];
    // find matching end, tracking nesting
    let depth = 1, j = i, elseAt = -1, endAt = -1;
    const tagRe = /\{\{\s*(#if|#each|\/if|\/each|else)\b[^}]*\}\}/g;
    tagRe.lastIndex = i;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(tpl))) {
      if (t[1].startsWith("#")) depth++;
      else if (t[1] === "else" && depth === 1) elseAt = t.index;
      else if (t[1].startsWith("/")) { depth--; if (depth === 0) { endAt = t.index; j = tagRe.lastIndex; break; } }
    }
    if (endAt < 0) throw new Error(`unclosed {{#${kind}}} in template`);
    const body = tpl.slice(i, elseAt >= 0 ? elseAt : endAt);
    const elseBody = elseAt >= 0 ? tpl.slice(tpl.indexOf("}}", elseAt) + 2, endAt) : "";
    const v = vars[name];
    if (kind === "if") out += render(stripLead(truthy(v) ? body : elseBody), vars);
    else for (const item of (Array.isArray(v) ? v : [])) out += render(stripLead(body), { ...vars, ...(item as Vars) });
    i = j;
    if (tpl[i] === "\n") i++; // a block tag on its own line leaves no blank line
  }
  return out;
}
const stripLead = (s: string) => (s.startsWith("\n") ? s.slice(1) : s);
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

export function systemBlocks(): string[] {
  return [render(PROMPT_TEXT.identity, { AGENT_NAME }), PROMPT_TEXT.system_base];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trimEnd();
  } catch {
    return null;
  }
}

function detectTools(): string {
  const names = ["git", "rg", "bun", "node", "python3", "npm", "make", "cargo", "go"];
  const found = names.filter((n) => Bun.which(n));
  return found.join(", ") || "none detected";
}

export interface ContextInput {
  cwd: string;
  interactionMode: InteractionMode;
  autonomy: AutonomyLevel;
  modelId: string;
  shell: string;
}

/** Context blocks for the first user message (prompts.md §4; skills and project instructions are Phase 5). */
export function contextBlocks(c: ContextInput): string[] {
  const env = render(PROMPT_TEXT.ctx_environment, {
    OS_NAME: os.type(), OS_VERSION: os.release(), ARCH: os.arch(), SHELL: c.shell,
    PATH_STYLE: process.platform === "win32" ? "windows" : "posix", HOME_DIR: os.homedir(),
    DETECTED_TOOLS: detectTools(), SANDBOX_STATUS: "off (not available in this build)",
    NETWORK_STATUS: "not restricted by the harness",
  });
  const isGit = git(c.cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  let statusLines: string[] = [];
  let branch = "", defBranch = "", log = "";
  if (isGit) {
    statusLines = (git(c.cwd, ["status", "--short"]) ?? "").split("\n").filter(Boolean);
    branch = git(c.cwd, ["branch", "--show-current"]) || "(detached)";
    defBranch = (git(c.cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) ?? "").replace(/^origin\//, "") || "unknown";
    log = git(c.cwd, ["log", "--oneline", "-5"]) || "(no commits)";
  }
  const STATUS_MAX = 50;
  let listing = "";
  try {
    listing = readdirSync(c.cwd, { withFileTypes: true })
      .filter((d) => d.name !== ".git").slice(0, 100)
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n");
  } catch { listing = "(unreadable)"; }
  const session = render(PROMPT_TEXT.ctx_session, {
    DATE: new Date().toISOString().slice(0, 10), TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
    CWD: c.cwd, INTERACTION_MODE: c.interactionMode, AUTONOMY_LEVEL: c.autonomy, TOOL_EXECUTION_MODE: "direct_only",
    MODEL_ID: c.modelId, IS_GIT_REPO: isGit ? "yes" : "", GIT_BRANCH: branch, GIT_DEFAULT_BRANCH: defBranch,
    GIT_STATUS_TRUNCATED: statusLines.length > STATUS_MAX, GIT_STATUS_SHOWN: STATUS_MAX,
    GIT_STATUS_SHORT: statusLines.slice(0, STATUS_MAX).join("\n") || "(clean)", GIT_LOG_ONELINE: log, CWD_LISTING: listing,
  }).replace("Git repository: \n", "Git repository: no\n");
  const todos = render(PROMPT_TEXT.ctx_todos, { TODOS: [] });
  return [env, session, todos];
}

export function guardText(id: keyof typeof PROMPT_TEXT, vars: Vars = {}): string {
  return render(PROMPT_TEXT[id], vars);
}
