// Skill discovery, parsing, precedence, listing, and the Skill tool core (spec §5.8).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PROMPT_TEXT } from "../agent/prompt-text.generated.ts";
import { render } from "../agent/prompts.ts";
import { findGitRoot, projectRoot } from "../config/levels.ts";
import { normalizeName, parseFrontmatter, toStringList } from "../config/frontmatter.ts";
import { rigwellHome, userHomeDir } from "../storage/paths.ts";
import { loadSettings } from "../storage/settings.ts";

/** Bucket order, first wins (spec §5.8; only the buckets this build has). */
export type SkillBucket = "project-dir" | "user-dir" | "dynamic" | "builtin";
const BUCKET_ORDER: SkillBucket[] = ["project-dir", "user-dir", "dynamic", "builtin"];
export type SkillStatus = "enabled" | "disabled" | "invalid" | "shadowed";

/** Folder names searched inside a project or home dir. `.rigwell` is the primary; `.agents`/`.agent` are shared conventions. */
export const SKILL_ROOT_DIRS = [".rigwell", ".agents", ".agent"] as const;
export const MAX_SKILL_BODY = 10_000;
export const MAX_DYNAMIC_FOLDERS = 24;

export interface Skill {
  /** Normalized name (also the lookup key). Empty when the name is missing/invalid. */
  name: string;
  rawName?: string;
  description: string;
  body: string;
  filePath: string;
  bucket: SkillBucket;
  status: SkillStatus;
  /** Why it is not enabled (invalid/disabled/shadowed), and validation errors. */
  errors: string[];
  warnings: string[];
  allowedTools?: string[];
  version?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  /** Set on a skill that lost a same-bucket clash. */
  collision?: boolean;
}

export interface BuiltinSkill { name: string; description: string; body: string }
/** The mechanism ships with zero built-in skills (built-in content needs approval, spec §1). */
export const BUILTIN_SKILLS: BuiltinSkill[] = [];

const NAME_RE = /^[a-z0-9-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Parse one SKILL.md text into a Skill (status before precedence). */
export function parseSkillFile(filePath: string, text: string, bucket: SkillBucket): Skill {
  const fm = parseFrontmatter(text);
  const d = fm.data ?? {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const body = fm.body.trim();
  const sk: Skill = {
    name: "", description: "", body, filePath, bucket, status: "enabled", errors, warnings,
    userInvocable: true, disableModelInvocation: false,
  };
  // schema checks: wrong types => loaded but disabled with an empty description
  let schemaBad = false;
  const isBool = (v: unknown) => v === undefined || typeof v === "boolean";
  if (d.name !== undefined && typeof d.name !== "string") schemaBad = true;
  if (d.description !== undefined && typeof d.description !== "string") schemaBad = true;
  if (!isBool(d.enabled) || !isBool(d["user-invocable"]) || !isBool(d["disable-model-invocation"])) schemaBad = true;
  const tools = toStringList(d["allowed-tools"]) ?? toStringList(d.tools);
  if (tools) sk.allowedTools = tools;

  const rawName = typeof d.name === "string" ? d.name.trim() : "";
  sk.rawName = rawName || undefined;
  if (!rawName) errors.push("name is missing");
  else if (!NAME_RE.test(rawName)) errors.push(`name "${rawName}" must match ^[a-z0-9-]+$`);
  if (!body) errors.push("body is empty");
  if (errors.length) { sk.status = "invalid"; sk.name = rawName ? normalizeName(rawName) : ""; return sk; }
  sk.name = rawName;

  if (schemaBad) { sk.status = "disabled"; sk.description = ""; errors.push("frontmatter failed schema checks"); return sk; }
  sk.description = typeof d.description === "string" ? d.description.trim() : "";
  if (sk.description.length > 200) warnings.push("description is over 200 characters");
  if (typeof d.version === "string") { if (SEMVER.test(d.version)) sk.version = d.version; } else if (d.version !== undefined) { /* dropped */ }
  if (body.length < 50) warnings.push("body is under 50 characters");
  if (body.length > MAX_SKILL_BODY) warnings.push("body is over 10,000 characters");
  if (d.enabled === false) { sk.status = "disabled"; errors.push("enabled: false"); }
  if (d["user-invocable"] === false) sk.userInvocable = false;
  if (d["disable-model-invocation"] === true) sk.disableModelInvocation = true;
  return sk;
}

/** Skills in `<skillsDir>/<name>/SKILL.md` (also `skill.mdx`), sorted by folder name. */
function scanSkillsDir(skillsDir: string, bucket: SkillBucket): Skill[] {
  let names: string[];
  try { names = readdirSync(skillsDir).sort(); } catch { return []; }
  const out: Skill[] = [];
  for (const n of names) {
    const dir = path.join(skillsDir, n);
    for (const f of ["SKILL.md", "skill.mdx"]) {
      const file = path.join(dir, f);
      try {
        if (!statSync(file).isFile()) continue;
        out.push(parseSkillFile(file, readFileSync(file, "utf8"), bucket));
        break;
      } catch { /* not there */ }
    }
  }
  return out;
}

export interface LoadSkillsOptions {
  cwd: string;
  /** Test override for the "no project" home check and the personal `.agents` dirs. */
  homeDir?: string;
  /** Names turned off in settings (`disabledSkills`). Default: read from loaded settings. */
  disabledSkills?: string[];
  builtins?: BuiltinSkill[];
  /** Drop built-in skills for this session. */
  includeBuiltins?: boolean;
}

export class SkillRegistry {
  /** All skills found, including invalid/disabled/shadowed ones. */
  all: Skill[] = [];
  /** Names already announced to the model via the additional-skills reminder. */
  private announced = new Set<string>();
  private scannedDirs = new Set<string>();
  private disabled = new Set<string>();

  constructor(private opts: LoadSkillsOptions) {}

  /** Scan the session-start locations. */
  load(): this {
    const o = this.opts;
    const disabled = o.disabledSkills ?? ((loadSettings({ cwd: o.cwd, homeDir: o.homeDir }).settings.disabledSkills as string[] | undefined) ?? []);
    this.disabled = new Set(disabled.map(normalizeName));
    const found: Skill[] = [];
    const root = projectRoot(o.cwd, o.homeDir);
    if (root) for (const d of SKILL_ROOT_DIRS) found.push(...scanSkillsDir(path.join(root, d, "skills"), "project-dir"));
    const userDirs = [rigwellHome(), path.join(o.homeDir ?? userHomeDir(), ".agents"), path.join(o.homeDir ?? userHomeDir(), ".agent")];
    for (const d of userDirs) found.push(...scanSkillsDir(path.join(d, "skills"), "user-dir"));
    if (o.includeBuiltins !== false) {
      for (const b of o.builtins ?? BUILTIN_SKILLS) {
        found.push({ ...parseSkillFile("builtin:" + b.name, `---\nname: ${b.name}\ndescription: ${JSON.stringify(b.description)}\n---\n${b.body}`, "builtin") });
      }
    }
    this.all = [];
    this.resolve(found);
    return this;
  }

  /** Apply settings-disabled + precedence/collision to a batch appended after the existing skills. */
  private resolve(batch: Skill[]) {
    const winners = new Map<string, Skill>();
    for (const s of this.all) if (s.status === "enabled" || s.status === "disabled") winners.set(s.name, winners.get(s.name) ?? s);
    for (const s of batch) {
      if (s.status === "invalid") { this.all.push(s); continue; }
      if (this.disabled.has(s.name) && s.status === "enabled") { s.status = "disabled"; s.errors.push("turned off in settings (disabledSkills)"); }
      const w = winners.get(s.name);
      if (w) {
        s.status = "shadowed";
        s.collision = w.bucket === s.bucket;
        s.errors.push(s.collision ? `name collision with ${w.filePath}` : `shadowed by ${w.filePath}`);
      } else winners.set(s.name, s);
      this.all.push(s);
    }
  }

  /** Enabled skills in precedence order. */
  enabled(): Skill[] {
    const rank = (s: Skill) => BUCKET_ORDER.indexOf(s.bucket);
    return this.all.filter((s) => s.status === "enabled").sort((a, b) => rank(a) - rank(b));
  }
  /** Skills the model may be offered (enabled and not disable-model-invocation). */
  modelInvocable(): Skill[] { return this.enabled().filter((s) => !s.disableModelInvocation); }
  /** The Skill tool is removed from the tool list when this is false. */
  skillToolAvailable(): boolean { return this.modelInvocable().length > 0; }

  get(name: string): Skill | undefined {
    const n = normalizeName(name.replace(/^\//, "").trim());
    return this.all.find((s) => s.name === n && (s.status === "enabled" || s.status === "disabled")) ??
      this.all.find((s) => s.name === n);
  }

  // ------------------------------------------------------------ dynamic discovery
  /**
   * A tool touched `filePath`: walk from the git root (or cwd) down to its folder (at most 24 folders)
   * looking for `{.rigwell,.agents,.agent}/skills/*`. Returns the newly found, enabled, model-invocable skills.
   */
  discoverForPath(filePath: string): Skill[] {
    const cwd = path.resolve(this.opts.cwd);
    const top = findGitRoot(cwd) ?? cwd;
    let target = path.resolve(cwd, filePath);
    try { if (existsSync(target) && statSync(target).isFile()) target = path.dirname(target); } catch { /* keep */ }
    const rel = path.relative(top, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
    const dirs = [top];
    let cur = top;
    for (const seg of rel.split(path.sep).filter(Boolean)) { cur = path.join(cur, seg); dirs.push(cur); }
    const fresh: Skill[] = [];
    for (const d of dirs.slice(0, MAX_DYNAMIC_FOLDERS)) {
      if (this.scannedDirs.has(d)) continue;
      this.scannedDirs.add(d);
      // the project/home dirs are already loaded at session start
      for (const r of SKILL_ROOT_DIRS) {
        const sd = path.join(d, r, "skills");
        if (d === projectRoot(cwd, this.opts.homeDir)) continue;
        const batch = scanSkillsDir(sd, "dynamic");
        const before = this.all.length;
        this.resolve(batch);
        fresh.push(...this.all.slice(before).filter((s) => s.status === "enabled" && !s.disableModelInvocation && !this.announced.has(s.name)));
      }
    }
    return fresh;
  }

  /** Mark skills as announced (the loop sends the reminder text once). */
  markAnnounced(skills: Skill[]) { for (const s of skills) this.announced.add(s.name); }
  /** After compaction announced skills move into the main list: nothing to render separately any more. */
  afterCompaction() { this.announced.clear(); this.scannedDirs.clear(); }

  /** The `<skills>` context block (prompts.md §4.3), or null when no skill is model-invocable. */
  contextBlock(contextWindowTokens?: number): string | null {
    return renderSkillsBlock(this.modelInvocable(), contextWindowTokens);
  }
}

// ---------------------------------------------------------------- listing

/** Collapse whitespace; cut to 200 chars with an ellipsis. */
export function cleanDescription(d: string): string {
  const s = d.replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 199).trimEnd() + "…" : s;
}

/**
 * Render the skills block. Budget: tokens x 4 x 0.015 characters (8,000 when the window is unknown).
 * Built-ins always get a full line; the others get a full line in priority order while budget lasts, then name only.
 */
export function renderSkillsBlock(skills: Skill[], contextWindowTokens?: number): string | null {
  if (!skills.length) return null;
  const budget = contextWindowTokens && contextWindowTokens > 0 ? Math.floor(contextWindowTokens * 4 * 0.015) : 8000;
  let used = 0;
  const items = skills.map((s) => {
    const full = `- ${s.name}: ${cleanDescription(s.description)}`;
    if (s.bucket === "builtin") { used += full.length + 1; return { NAME: s.name, DESCRIPTION: cleanDescription(s.description) }; }
    if (used + full.length + 1 <= budget) { used += full.length + 1; return { NAME: s.name, DESCRIPTION: cleanDescription(s.description) }; }
    used += s.name.length + 3;
    return { NAME: s.name, DESCRIPTION: "" };
  });
  return render(PROMPT_TEXT.ctx_skills, { SKILLS: items }).replace(/^(- [^\n:]+): $/gm, "$1");
}

/** Short reminder naming skills found during the session (the lead appends it as a message). */
export function renderAdditionalSkills(skills: Skill[]): string | null {
  if (!skills.length) return null;
  return `<skills_added>\nMore skills are now available from the folder you just worked in. Run one with the Skill tool when it matches.\n${skills.map((s) => `- ${s.name}: ${cleanDescription(s.description)}`).join("\n")}\n</skills_added>`;
}

// ---------------------------------------------------------------- Skill tool core

export class SkillError extends Error {}

export interface SkillToolResult { name: string; instructions: string }

/**
 * The Skill tool: `{name, args}` -> `{name, instructions}`. `instructions` is the wrapped body (also the direct-mode
 * tool_result text). Throws SkillError (becomes a tool error) when not found / invalid / disabled / shadowed.
 */
export function runSkill(reg: SkillRegistry, input: { name: string; args?: string }): SkillToolResult {
  const asked = String(input.name ?? "").trim();
  if (!asked) throw new SkillError("Skill: name is required");
  const s = reg.get(asked);
  if (!s) {
    const names = reg.modelInvocable().map((x) => x.name);
    throw new SkillError(`Skill "${asked}" not found.${names.length ? ` Available skills: ${names.join(", ")}.` : " No skills are available."}`);
  }
  if (s.status === "invalid") throw new SkillError(`Skill "${asked}" is invalid: ${s.errors.join("; ")}`);
  if (s.status === "disabled") throw new SkillError(`Skill "${asked}" is disabled${s.errors.length ? ": " + s.errors.join("; ") : ""}`);
  if (s.status === "shadowed") throw new SkillError(`Skill "${asked}" is shadowed: ${s.errors.join("; ")}`);
  let body = s.body;
  if (body.length > MAX_SKILL_BODY) body = body.slice(0, MAX_SKILL_BODY) + `\n[skill body cut at ${MAX_SKILL_BODY} characters]`;
  const args = input.args?.trim();
  const instructions =
    `Skill "${s.name}" is now active. Follow its instructions for this task.\n` +
    `<skill name="${s.name}" filePath="${s.filePath}">\n${body}${args ? `\n\nArguments: ${args}` : ""}\n</skill>`;
  return { name: s.name, instructions };
}
