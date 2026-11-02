import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { SkillError, SkillRegistry, parseSkillFile, renderAdditionalSkills, renderSkillsBlock, runSkill } from "../../src/skills/index.ts";

let env: ReturnType<typeof tmpEnv>;
let proj: string;
beforeEach(() => { env = tmpEnv(); proj = path.join(env.root, "proj"); mkdirSync(path.join(proj, ".git"), { recursive: true }); });
afterEach(() => env.cleanup());

const BODY = "Step one: do the thing carefully. Step two: verify the thing was done properly.";
function skill(root: string, folder: string, fm: string, body = BODY, sub = ".rigwell") {
  const dir = path.join(root, sub, "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);
}
const load = (extra: object = {}) => new SkillRegistry({ cwd: proj, homeDir: env.home, builtins: [], ...extra }).load();

test("parse: valid, invalid name, empty body, bad schema, kv fallback, tools alias", () => {
  const ok = parseSkillFile("/x/SKILL.md", `---\nname: do-it\ndescription: Does it\nallowed-tools: Read, Grep\nversion: 1.2.3\n---\n${BODY}`, "project-dir");
  expect(ok).toMatchObject({ name: "do-it", status: "enabled", description: "Does it", allowedTools: ["Read", "Grep"], version: "1.2.3" });
  expect(parseSkillFile("/x", `---\nname: Bad_Name\n---\n${BODY}`, "project-dir").status).toBe("invalid");
  expect(parseSkillFile("/x", `---\nname: a\ndescription: d\n---\n   \n`, "project-dir")).toMatchObject({ status: "invalid", errors: ["body is empty"] });
  expect(parseSkillFile("/x", BODY, "project-dir").errors).toContain("name is missing");
  const bad = parseSkillFile("/x", `---\nname: a\ndescription: [1]\n---\n${BODY}`, "project-dir");
  expect(bad).toMatchObject({ status: "disabled", description: "" });
  const kv = parseSkillFile("/x", `---\nname: kv\ndescription: has: colon: here: [oops\n---\n${BODY}`, "project-dir");
  expect(kv.name).toBe("kv");
  const v = parseSkillFile("/x", `---\nname: a\ndescription: d\nversion: nope\ntools: Read\n---\n${BODY}`, "project-dir");
  expect(v.version).toBeUndefined();
  expect(v.allowedTools).toEqual(["Read"]);
  expect(parseSkillFile("/x", `---\nname: a\ndescription: ${"x".repeat(201)}\n---\nshort`, "project-dir").warnings.length).toBe(2);
  expect(parseSkillFile("/x", `---\nname: a\ndescription: d\nenabled: false\n---\n${BODY}`, "project-dir").status).toBe("disabled");
});

test("discovery: project beats user, first found in a level wins, .agents folders, collisions", () => {
  skill(proj, "alpha", "name: alpha\ndescription: project alpha");
  skill(env.home, "alpha", "name: alpha\ndescription: user alpha", BODY, ".rigwell");
  skill(env.home, "zeta", "name: zeta\ndescription: user zeta"); // $RIGWELL_HOME is <home>/.rigwell
  skill(proj, "beta", "name: beta\ndescription: in rigwell");
  skill(proj, "beta2", "name: beta\ndescription: in agents", BODY, ".agents");
  skill(proj, "broken", "description: no name");
  const r = load();
  const st = (n: string, d: string) => r.all.find((s) => s.name === n && s.description === d)!;
  expect(st("alpha", "project alpha").status).toBe("enabled");
  expect(st("alpha", "user alpha")).toMatchObject({ status: "shadowed", collision: false });
  expect(st("beta", "in rigwell").status).toBe("enabled");
  expect(st("beta", "in agents")).toMatchObject({ status: "shadowed", collision: true });
  expect(r.all.find((s) => s.filePath.includes("broken"))!.status).toBe("invalid");
  expect(r.enabled().map((s) => s.name)).toEqual(["alpha", "beta", "zeta"]);
});

test("project shadows user (different buckets); disabledSkills; disable-model-invocation", () => {
  skill(proj, "x", "name: x\ndescription: project x");
  mkdirSync(path.join(env.rigwellHome, "skills", "x"), { recursive: true });
  writeFileSync(path.join(env.rigwellHome, "skills", "x", "SKILL.md"), `---\nname: x\ndescription: user x\n---\n${BODY}`);
  skill(proj, "off", "name: off\ndescription: off by settings");
  skill(proj, "hidden", "name: hidden\ndescription: hidden\ndisable-model-invocation: true");
  const r = load({ disabledSkills: ["off"] });
  expect(r.all.find((s) => s.description === "user x")).toMatchObject({ status: "shadowed", collision: false });
  expect(r.all.find((s) => s.name === "off")!.status).toBe("disabled");
  expect(r.modelInvocable().map((s) => s.name)).toEqual(["x"]);
  expect(r.get("hidden")!.status).toBe("enabled");
  expect(() => runSkill(r, { name: "off" })).toThrow(SkillError);
});

test("context block: template, name-only after budget, omitted when empty", () => {
  expect(load().contextBlock()).toBeNull();
  expect(load().skillToolAvailable()).toBe(false);
  skill(proj, "one", "name: one\ndescription: First   skill\n  with spaces");
  skill(proj, "two", "name: two\ndescription: " + "y".repeat(300));
  const r = load();
  const block = r.contextBlock()!;
  expect(block).toContain("<skills>");
  expect(block).toContain("- one: First skill with spaces");
  expect(block).toMatch(/- two: y{199}…/);
  // tiny window: budget ~ 1 char => only names
  const tiny = renderSkillsBlock(r.modelInvocable(), 10)!;
  expect(tiny).toContain("\n- one\n");
  expect(tiny).toContain("\n- two\n");
});

test("Skill tool: wrapped body, args line, errors, size cap, slash prefix", () => {
  skill(proj, "go", "name: go\ndescription: Go", BODY);
  skill(proj, "big", "name: big\ndescription: Big", "z".repeat(12000));
  const r = load();
  const res = runSkill(r, { name: "go", args: "fast please" });
  expect(res.name).toBe("go");
  expect(res.instructions).toContain('<skill name="go" filePath="');
  expect(res.instructions).toContain(BODY);
  expect(res.instructions).toContain("Arguments: fast please");
  expect(runSkill(r, { name: "/GO" }).name).toBe("go");
  expect(runSkill(r, { name: "big" }).instructions).toContain("[skill body cut at 10000 characters]");
  expect(() => runSkill(r, { name: "missing" })).toThrow(/not found.*go/);
});

test("dynamic discovery walks from the git root to the touched path, once", () => {
  const sub = path.join(proj, "pkg", "deep");
  skill(path.join(proj, "pkg"), "pkgskill", "name: pkgskill\ndescription: pkg only", BODY);
  skill(sub, "deepskill", "name: deepskill\ndescription: deep only", BODY, ".agents");
  skill(proj, "top", "name: top\ndescription: at start");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, "f.ts"), "x");
  const r = load();
  expect(r.enabled().map((s) => s.name)).toEqual(["top"]);
  const added = r.discoverForPath(path.join(sub, "f.ts"));
  expect(added.map((s) => s.name).sort()).toEqual(["deepskill", "pkgskill"]);
  expect(added[0].bucket).toBe("dynamic");
  expect(renderAdditionalSkills(added)).toContain("- pkgskill: pkg only");
  expect(r.discoverForPath(path.join(sub, "f.ts"))).toEqual([]);
  expect(r.discoverForPath("/etc/passwd")).toEqual([]);
  expect(runSkill(r, { name: "deepskill" }).name).toBe("deepskill");
});

test("built-in mechanism: injected builtins appear and lose to project skills", () => {
  expect(load().all).toEqual([]);
  skill(proj, "dup", "name: dup\ndescription: project dup");
  const r = load({ builtins: [{ name: "dup", description: "builtin dup", body: BODY }, { name: "bi", description: "builtin", body: BODY }] });
  expect(r.enabled().map((s) => s.name)).toEqual(["dup", "bi"]);
  expect(r.all.find((s) => s.bucket === "builtin" && s.name === "dup")!.status).toBe("shadowed");
  expect(load({ builtins: [{ name: "bi", description: "b", body: BODY }], includeBuiltins: false }).all.filter((x) => x.bucket === "builtin")).toEqual([]);
});
