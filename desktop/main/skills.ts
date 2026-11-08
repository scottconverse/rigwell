// Skills for the composer's Skills dialog (spec §5.8, §14.3). The daemon has no "list skills" method, so the main process
// scans the same folders the agent uses, through the shared registry.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SkillRegistry, type Skill } from "../../src/skills/skills.ts";
import { projectRoot } from "../../src/config/levels.ts";
import { rigwellHome } from "../../src/storage/paths.ts";
import { buildSkillMd, validateNewSkill } from "../renderer/lib/skill-md.ts";

export interface SkillView { name: string; description: string; bucket: string; status: string; filePath: string; body: string; errors: string[]; userInvocable: boolean }

export function listSkillViews(cwd: string): SkillView[] {
  const reg = new SkillRegistry({ cwd }).load();
  return reg.all.map((s: Skill) => ({
    name: s.name || s.rawName || "(unnamed)", description: s.description, bucket: s.bucket, status: s.status, filePath: s.filePath,
    body: s.body, errors: s.errors, userInvocable: s.userInvocable,
  }));
}

export type CreateSkillResult = { ok: true; filePath: string } | { ok: false; error: string; exists?: boolean };

/** Where a new skill's folder goes: `$RIGWELL_HOME/skills/<name>` (user) or `<project root>/.rigwell/skills/<name>` (project). */
export function skillDir(scope: "user" | "project", cwd: string, name: string): string | null {
  if (scope === "user") return path.join(rigwellHome(), "skills", name);
  const root = cwd ? projectRoot(cwd) : null;
  return root ? path.join(root, ".rigwell", "skills", name) : null;
}

/** Writes `<dir>/SKILL.md`. An existing SKILL.md is only replaced when `overwrite` is true; otherwise `exists` is reported. */
export function createSkill(cwd: string, input: { name: string; description: string; body: string; scope: "user" | "project"; overwrite?: boolean }): CreateSkillResult {
  const skill = { name: String(input?.name ?? ""), description: String(input?.description ?? ""), body: String(input?.body ?? "") };
  const errs = validateNewSkill(skill);
  if (errs.length) return { ok: false, error: errs.join(" ") };
  if (input.scope !== "user" && input.scope !== "project") return { ok: false, error: "Scope must be user or project." };
  const dir = skillDir(input.scope, cwd, skill.name);
  if (!dir) return { ok: false, error: "There is no project folder for this session. Choose the user scope instead." };
  const file = path.join(dir, "SKILL.md");
  if (existsSync(file) && !input.overwrite) return { ok: false, error: `A skill named ${skill.name} already exists at ${file}.`, exists: true };
  try { mkdirSync(dir, { recursive: true }); writeFileSync(file, buildSkillMd(skill), "utf8"); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, filePath: file };
}
