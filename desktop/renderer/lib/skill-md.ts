// Pure helpers for creating a skill from the desktop: name validation and the SKILL.md text (same frontmatter the
// registry in src/skills/skills.ts parses: `name` must match ^[a-z0-9-]+$, a non-empty body is required).

export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 200;
/** Folder names Windows refuses; a skill folder with one of these names could not be created there. */
const RESERVED = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/** An error message, or "" when the name is a safe folder name the skill registry accepts. */
export function validateSkillName(name: string): string {
  if (!name) return "Enter a name.";
  if (name.length > MAX_SKILL_NAME) return `Use at most ${MAX_SKILL_NAME} characters.`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "Use lowercase letters, digits and single hyphens only (for example code-review).";
  if (RESERVED.has(name)) return `"${name}" is a reserved folder name.`;
  return "";
}

export interface NewSkill { name: string; description: string; body: string }

/** Errors for the whole form (empty list when it can be saved). */
export function validateNewSkill(s: NewSkill): string[] {
  const errs: string[] = [];
  const n = validateSkillName(s.name);
  if (n) errs.push(n);
  if (!s.description.trim()) errs.push("Enter a description.");
  if (!s.body.trim()) errs.push("Enter the instructions.");
  return errs;
}

/** The SKILL.md text. The description is written as a one-line JSON string, which is valid YAML. */
export function buildSkillMd(s: NewSkill): string {
  const description = s.description.replace(/\s+/g, " ").trim();
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${s.body.replace(/\r\n/g, "\n").trim()}\n`;
}
