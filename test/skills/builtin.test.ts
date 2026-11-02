import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { BUILTIN_SKILLS, SkillRegistry, parseSkillFile, runSkill } from "../../src/skills/index.ts";
import { makeStubSession, text } from "../agent/helpers.ts";

const srcDir = path.join(import.meta.dir, "../../src/skills/builtin");
let env: ReturnType<typeof tmpEnv>;
let proj: string;
beforeEach(() => { env = tmpEnv(); proj = path.join(env.root, "proj"); mkdirSync(path.join(proj, ".git"), { recursive: true }); });
afterEach(() => env.cleanup());
const load = (extra: object = {}) => new SkillRegistry({ cwd: proj, homeDir: env.home, ...extra }).load();

test("every SKILL.md source parses, is valid, and matches the generated bundle", () => {
  const dirs = readdirSync(srcDir).sort();
  expect(dirs.length).toBeGreaterThanOrEqual(15);
  expect(BUILTIN_SKILLS.map((b) => b.name)).toEqual(dirs);
  for (const d of dirs) {
    const file = path.join(srcDir, d, "SKILL.md");
    const raw = readFileSync(file, "utf8");
    const sk = parseSkillFile(file, raw, "builtin");
    expect(sk.errors).toEqual([]);
    expect(sk.warnings).toEqual([]);
    expect(sk.status).toBe("enabled");
    expect(sk.name).toBe(d);
    expect(sk.description.length).toBeGreaterThan(20);
    const words = sk.body.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(100);
    expect(words).toBeLessThanOrEqual(600);
    expect(raw).not.toContain("—");
    const b = BUILTIN_SKILLS.find((x) => x.name === d)!;
    expect(b.body).toBe(sk.body);
    expect(b.description).toBe(sk.description);
  }
});

test("names and descriptions are unique; no vendor names", () => {
  expect(new Set(BUILTIN_SKILLS.map((b) => b.name)).size).toBe(BUILTIN_SKILLS.length);
  expect(new Set(BUILTIN_SKILLS.map((b) => b.description)).size).toBe(BUILTIN_SKILLS.length);
  for (const b of BUILTIN_SKILLS) expect(`${b.name} ${b.description} ${b.body}`).not.toMatch(/droid|factory/i);
});

test("all built-ins load enabled, appear in the skills context block, and the Skill tool returns their instructions", () => {
  const r = load();
  const names = BUILTIN_SKILLS.map((b) => b.name);
  expect(r.enabled().map((s) => s.name).sort()).toEqual([...names].sort());
  expect(r.skillToolAvailable()).toBe(true);
  const block = r.contextBlock(200_000)!;
  for (const b of BUILTIN_SKILLS) expect(block).toContain(`- ${b.name}: `);
  for (const b of BUILTIN_SKILLS) {
    const out = runSkill(r, { name: b.name, args: "focus here" });
    expect(out.name).toBe(b.name);
    expect(out.instructions).toContain(b.body);
    expect(out.instructions).toContain("Arguments: focus here");
  }
});

test("disabledSkills turns individual built-ins off; includeBuiltins false drops them all", () => {
  const r = load({ disabledSkills: ["review", "init"] });
  expect(r.enabled().map((s) => s.name)).not.toContain("review");
  expect(r.contextBlock()).not.toContain("- review:");
  expect(r.contextBlock()).toContain("- simplify:");
  expect(() => runSkill(r, { name: "review" })).toThrow(/disabled/);
  const none = load({ includeBuiltins: false });
  expect(none.all).toEqual([]);
  expect(none.skillToolAvailable()).toBe(false);
});

test("disabledSkills in a settings file applies to built-ins", () => {
  mkdirSync(path.join(proj, ".rigwell"), { recursive: true });
  writeFileSync(path.join(proj, ".rigwell", "settings.json"), JSON.stringify({ disabledSkills: ["incident"] }));
  const r = load();
  expect(r.enabled().map((s) => s.name)).not.toContain("incident");
  expect(r.enabled().map((s) => s.name)).toContain("visualize");
});

test("a project skill with a built-in name wins", () => {
  const dir = path.join(proj, ".rigwell", "skills", "review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: review\ndescription: mine\n---\nMy own review steps are long enough to count as a body here.\n");
  const r = load();
  expect(runSkill(r, { name: "review" }).instructions).toContain("My own review steps");
  expect(r.all.find((s) => s.bucket === "builtin" && s.name === "review")!.status).toBe("shadowed");
});

test("a session offers the built-ins by default and drops them with disableBuiltinSkills", async () => {
  const on = makeStubSession(() => text("ok"), { disableBuiltinSkills: false });
  on.session.addUserMessage("hi");
  await on.session.settled();
  const req = on.requests[0]!;
  expect(req.tools.map((t) => t.name)).toContain("Skill");
  const ctx = JSON.stringify(req.messages[0]);
  expect(ctx).toContain("<skills>");
  expect(ctx).toContain("- security-review: ");

  const off = makeStubSession(() => text("ok"), { disableBuiltinSkills: true });
  off.session.addUserMessage("hi");
  await off.session.settled();
  expect(off.requests[0]!.tools.map((t) => t.name)).not.toContain("Skill");
  expect(JSON.stringify(off.requests[0]!.messages[0])).not.toContain("<skills>");
});
