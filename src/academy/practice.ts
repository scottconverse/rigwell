import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { lessonById, LESSONS } from "./catalog.ts";
import { makePrivate } from "../platform/private.ts";
import { validateCustomModels } from "../storage/models.ts";
import { parseSkillFile } from "../skills/skills.ts";
import { normalizeGroups } from "../hooks/config.ts";
import { normalizeServer } from "../mcp/config.ts";
import { checkFeaturesJson } from "../missions/store.ts";
import { budgetFrom } from "../workstreams/limits.ts";
import { parseHeartbeat, validateFrontmatter, type Frontmatter } from "../automations/store.ts";

const PREFIX = "rigwell-academy-", MARKER = ".academy-owned.json";
interface Practice { id: string; lesson: string; createdAt: string; version: 1; passed?: boolean }
function pathIn(root: string, file: string) {
  const target = resolve(root, file), rel = relative(root, target);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== target) throw new Error("Invalid practice path");
  let p = root;
  for (const part of rel.split(/[\\/]/)) { p = join(p, part); try { if (lstatSync(p).isSymbolicLink()) throw new Error("Practice paths cannot contain links"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  return target;
}
function canonical(path: string) {
  const resolved = realpathSync.native(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function base() { return realpathSync.native(tmpdir()); }
function owned(id: string) {
  if (!/^[a-zA-Z0-9]{6}$/.test(id)) throw new Error("Invalid practice id");
  const root = join(base(), PREFIX + id), st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || canonical(root) !== (process.platform === "win32" ? root.toLowerCase() : root)) throw new Error("Practice is not an owned temporary directory");
  const file = pathIn(root, MARKER); if (lstatSync(file).size > 4096) throw new Error("Invalid practice marker");
  const record = JSON.parse(readFileSync(file, "utf8")) as Practice;
  if (record.version !== 1 || record.id !== id || typeof record.createdAt !== "string") throw new Error("Invalid practice marker");
  const lesson = lessonById(record.lesson); return { root, record, lesson };
}
function git(root: string, ...args: string[]) {
  const dotgit = pathIn(root, ".git"); if (existsSync(dotgit) && !lstatSync(dotgit).isDirectory()) throw new Error("Practice Git metadata must be a local directory");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return execFileSync("git", ["-c", "core.hooksPath=" + join(root, ".academy-empty-hooks"), "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } }).trim();
}
export function startPractice(topic: string) {
  const lesson = lessonById(topic), root = mkdtempSync(join(base(), PREFIX)); makePrivate(root, { dir: true });
  const id = root.slice(root.lastIndexOf(PREFIX) + PREFIX.length), record: Practice = { version: 1, id, lesson: topic, createdAt: new Date().toISOString() };
  writeFileSync(join(root, MARKER), JSON.stringify(record), { mode: 0o600 });
  try {
    git(root, "init", "-q", "-b", "lesson-base");
    writeFileSync(pathIn(root, ".git/info/exclude"), `/${MARKER}\n/.practice-worktrees/\n`);
    writeFileSync(join(root, "README.md"), `# Rigwell Academy sample\n\n${lesson.title}\n\nThis is a disposable practice repository. No remote is configured.\n\n${lesson.goal}\n`);
    const file = pathIn(root, lesson.file); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lesson.starter);
    git(root, "add", "."); git(root, "-c", "user.name=Academy", "-c", "user.email=academy@example.test", "commit", "-qm", "Start local practice");
    return readPractice(id);
  } catch (e) { // Record ownership before initialization so a failed setup can be safely cleaned.
    const checked = owned(id); rmSync(checked.root, { recursive: true, force: true }); throw e;
  }
}
export function readPractice(id: string) {
  const { root, record, lesson } = owned(id), file = pathIn(root, lesson.file);
  if (lstatSync(file).size > 64 * 1024) throw new Error("Practice file exceeds 64 KiB");
  return { ...record, root, file: lesson.file, content: readFileSync(file, "utf8"), lesson };
}
export function listPractice() {
  return readdirSync(base()).filter((s) => s.startsWith(PREFIX)).flatMap((s) => { try { const { root, record } = owned(s.slice(PREFIX.length)); return [{ ...record, root }]; } catch { return []; } }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function savePractice(id: string, text: string) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) throw new Error("Practice content must be at most 64 KiB");
  const { root, lesson, record } = owned(id); writeFileSync(pathIn(root, lesson.file), text, { mode: 0o600 });
  writeFileSync(pathIn(root, MARKER), JSON.stringify({ ...record, passed: false }), { mode: 0o600 }); return readPractice(id);
}
export function createPracticeWorktree(id: string) {
  const { root, lesson } = owned(id); if (lesson.id !== "worktrees") throw new Error("This action belongs to the worktrees lesson");
  const target = pathIn(root, ".practice-worktrees/lesson");
  if (existsSync(target)) throw new Error("Practice worktree already exists");
  mkdirSync(dirname(target), { recursive: true }); git(root, "worktree", "add", "-q", "-b", "academy-practice", target);
  return { path: target, branch: "academy-practice" };
}
export function checkPractice(id: string) {
  const { root, lesson, record } = owned(id), content = readPractice(id).content; let message = "";
  try {
    const json = () => JSON.parse(content);
    switch (lesson.id) {
      case "getting-started": {
        const scope = /## Scope\s+([^#]+)/i.exec(content)?.[1]?.trim(), validation = /## Validation\s+([^#]+)/i.exec(content)?.[1]?.trim();
        if (!scope || scope.length < 20 || !validation || validation.length < 20) throw new Error("Add concrete rules under both Scope and Validation (at least 20 characters each).");
        message = "Project scope and validation instructions are present."; break;
      }
      case "models-and-keys": {
        const profile = json(); if (!profile || typeof profile !== "object" || Array.isArray(profile) || Object.keys(profile).some((k) => !["provider", "model", "displayName", "baseUrl"].includes(k))) throw new Error("Use only provider, model, displayName and baseUrl; never enter credentials here.");
        if (profile.provider !== "generic-chat-completion-api" || typeof profile.baseUrl !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(profile.baseUrl)) throw new Error("Choose the key-free generic Chat Completions adapter and a loopback HTTP baseUrl.");
        const parsed = validateCustomModels({ customModels: [profile] }, {}); if (parsed.problems.length || parsed.models.length !== 1) throw new Error(parsed.problems.map((p) => p.message).join("; "));
        message = "Local profile format is valid. No endpoint was contacted and no model access was tested."; break;
      }
      case "skills": {
        const parsed = parseSkillFile(pathIn(root, lesson.file), content, "project-dir"); if (parsed.name !== "academy-example" || parsed.errors.length) throw new Error(parsed.errors.join("; ") || "Use the academy-example skill name.");
        message = "Skill parser accepted the definition. Instructions were not executed."; break;
      }
      case "hooks": {
        const groups = normalizeGroups(json()?.hooks?.SessionStart, "project"); if (!groups.some((g) => g.hooks.some((h) => h.command === "echo academy-ready"))) throw new Error("Add the SessionStart command hook echo academy-ready.");
        message = "SessionStart configuration is valid. No hook was run."; break;
      }
      case "mcp": {
        const server = normalizeServer("academy-example", json()?.mcpServers?.["academy-example"], "project");
        if (server?.type !== "stdio" || server.command !== "bun" || JSON.stringify(server.args) !== '["--version"]') throw new Error("Use a stdio academy-example server with command bun and args [\"--version\"].");
        message = "Server configuration is valid. No process or MCP connection was started."; break;
      }
      case "worktrees": {
        const target = pathIn(root, ".practice-worktrees/lesson"), rows = git(root, "worktree", "list", "--porcelain", "-z");
        if (!existsSync(target) || !rows.split("\0\0").some((row) => {
          const fields = row.split("\0"), registered = fields.find((field) => field.startsWith("worktree "))?.slice(9);
          return registered && fields.includes("branch refs/heads/academy-practice") && canonical(registered) === canonical(target);
        })) throw new Error("Create the practice worktree first.");
        if (content.replace(/^#.*$/gm, "").trim().length < 40) throw new Error("Record a concrete observation about branch and folder isolation (at least 40 characters).");
        message = "Git confirms the separate practice worktree/branch and your observation is saved. No push occurred."; break;
      }
      case "missions": {
        const invalid = checkFeaturesJson(content); if (invalid) throw new Error(invalid);
        const features = json().features; if (!features.length || !features.every((f: any) => f.status === "pending" && f.expectedBehavior?.some((s: string) => s.trim().length >= 10))) throw new Error("Add a pending feature with concrete expectedBehavior.");
        message = "Mission feature format is valid. No mission or worker was started."; break;
      }
      case "workstreams": {
        const p = json(); if (![p.title, p.goal, p.plan].every((s) => typeof s === "string" && s.trim().length >= 5) || !Array.isArray(p.agents) || !p.agents.length || !p.agents.every((a: any) => [a.name, a.role, a.prompt].every((s) => typeof s === "string" && s.trim()))) throw new Error("Supply a title, goal, plan and a member name, role and prompt.");
        if (!(budgetFrom(p.budget)?.maxWallMinutes! > 0)) throw new Error("Choose a positive maxWallMinutes budget.");
        message = "Plan fields and budget are valid. User approval and member execution remain separate."; break;
      }
      case "automations": {
        const parsed = parseHeartbeat(content); validateFrontmatter(parsed.fm as unknown as Frontmatter);
        if (parsed.fm.schedule !== "every 5m" || parsed.fm.autonomy !== "high" || parsed.body.trim().length < 40) throw new Error("Use every 5m, high autonomy and a concrete prompt of at least 40 characters.");
        message = "Heartbeat and schedule are valid. No automation was registered or run."; break;
      }
    }
    writeFileSync(pathIn(root, MARKER), JSON.stringify({ ...record, passed: true }), { mode: 0o600 });
    return { passed: true, message };
  } catch (e) {
    writeFileSync(pathIn(root, MARKER), JSON.stringify({ ...record, passed: false }), { mode: 0o600 });
    return { passed: false, message: (e as Error).message };
  }
}
export function removePractice(id: string, confirmed: boolean) {
  if (confirmed !== true) throw new Error("Confirm removal of this sample and all of its edits");
  const { root } = owned(id); rmSync(root, { recursive: true, force: true }); return { removed: true };
}
export const academyMethods = {
  list_lessons: () => ({ lessons: LESSONS, practices: listPractice() }),
  start_lesson: (p: any) => startPractice(String(p.lesson)),
  read_lesson_practice: (p: any) => readPractice(String(p.id)),
  save_lesson_practice: (p: any) => savePractice(String(p.id), p.content),
  check_lesson_practice: (p: any) => checkPractice(String(p.id)),
  create_lesson_worktree: (p: any) => createPracticeWorktree(String(p.id)),
  remove_lesson_practice: (p: any) => removePractice(String(p.id), p.confirmed),
};
