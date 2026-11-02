// Org-managed settings (spec 12.2): a local file is the highest level and lower levels cannot loosen it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHooksConfig } from "../../src/hooks/config.ts";
import { DEFAULT_COMMAND_LISTS } from "../../src/permissions/lists.ts";
import { autonomyAllowed, clampAutonomy, managedLabel, modelAllowed, ORG_ENV } from "../../src/storage/org.ts";
import { loadSettings } from "../../src/storage/settings.ts";

let home = "";
let proj = "";
let orgFile = "";
const saved = { h: process.env.RIGWELL_HOME, o: process.env[ORG_ENV] };
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "rigwell-org-home-"));
  proj = mkdtempSync(path.join(tmpdir(), "rigwell-org-proj-"));
  orgFile = path.join(mkdtempSync(path.join(tmpdir(), "rigwell-org-file-")), "org.json");
  process.env.RIGWELL_HOME = home;
  process.env[ORG_ENV] = orgFile;
});
afterEach(() => {
  if (saved.h === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = saved.h;
  if (saved.o === undefined) delete process.env[ORG_ENV]; else process.env[ORG_ENV] = saved.o;
});

const user = (o: object) => writeFileSync(path.join(home, "settings.json"), JSON.stringify(o));
const org = (o: object) => writeFileSync(orgFile, JSON.stringify(o));
const load = () => loadSettings({ cwd: proj, homeDir: home });

test("no env variable: no org level", () => {
  delete process.env[ORG_ENV];
  const r = load();
  expect(r.managedKeys).toEqual([]);
  expect(r.sources.some((s) => s.level === "org")).toBe(false);
});

test("the org file is the highest level and its keys are labeled", () => {
  user({ diffMode: "unified", theme: "x" });
  org({ diffMode: "github", maxAutonomyLevel: "medium" });
  const r = load();
  expect(r.settings.diffMode).toBe("github");
  expect(r.sources[0]).toMatchObject({ level: "org", path: orgFile });
  expect(r.managedKeys.sort()).toEqual(["diffMode", "maxAutonomyLevel"]);
  expect(managedLabel(r.managedKeys, "diffMode")).toBe("[managed by org]");
  expect(managedLabel(r.managedKeys, "theme")).toBe("");
});

test("a {managedSettings: {...}} wrapper works; a broken file warns and changes nothing", () => {
  org({ managedSettings: { diffMode: "github" } });
  expect(load().settings.diffMode).toBe("github");
  writeFileSync(orgFile, "{nope");
  const r = load();
  expect(r.warnings.join("\n")).toContain("invalid JSON");
  expect(r.managedKeys).toEqual([]);
});

test("maxAutonomyLevel clamps the default a lower level set", () => {
  user({ sessionDefaultSettings: { autonomyLevel: "high" } });
  org({ maxAutonomyLevel: "low" });
  expect(load().settings.sessionDefaultSettings?.autonomyLevel).toBe("low");
  expect(clampAutonomy("high", "medium")).toBe("medium");
  expect(clampAutonomy("off", "medium")).toBe("off");
  expect(autonomyAllowed("high", "medium")).toBe(false);
  expect(autonomyAllowed("high", undefined)).toBe(true);
});

test("command lists: deny and block only grow; an org allowlist is the whole allowlist", () => {
  user({ commandDenylist: ["my-own"], commandBlocklist: [], commandAllowlist: ["git status", "npm test"] });
  org({ commandDenylist: ["curl"], commandBlocklist: ["npm publish"], commandAllowlist: ["ls"] });
  const s = load().settings;
  expect(s.commandDenylist).toEqual(["my-own", "curl"]);
  expect(s.commandBlocklist).toEqual(["npm publish"]);
  expect(s.commandAllowlist).toEqual(["ls"]);
});

test("org deny keeps the built-in deny entries when no lower level set a list", () => {
  org({ commandDenylist: ["curl"] });
  const s = load().settings;
  expect(s.commandDenylist).toEqual([...DEFAULT_COMMAND_LISTS.deny, "curl"]);
});

test("modelPolicy: org copy replaces lower copies; allowCustomModels false drops BYOK models", () => {
  user({
    modelPolicy: { allowCustomModels: true, allowedModelIds: ["everything"] },
    customModels: [{ model: "m", provider: "openai", baseUrl: "http://x" }],
  });
  org({ modelPolicy: { allowCustomModels: false, blockedModelIds: ["bad"] }, customModels: [{ model: "org-m", provider: "openai", baseUrl: "http://org" }] });
  const s = load().settings;
  expect(s.modelPolicy).toEqual({ allowCustomModels: false, blockedModelIds: ["bad"] });
  expect(s.customModels?.map((m) => m.model)).toEqual(["org-m"]);
});

test("modelAllowed: blocked, allowed list and custom switch", () => {
  expect(modelAllowed(undefined, ["a"], true)).toBe(true);
  expect(modelAllowed({ blockedModelIds: ["a"] }, ["x", "a"], false)).toBe(false);
  expect(modelAllowed({ allowedModelIds: ["a"] }, ["b"], false)).toBe(false);
  expect(modelAllowed({ allowedModelIds: ["a"] }, ["b", "a"], false)).toBe(true);
  expect(modelAllowed({ allowCustomModels: false }, ["custom:x"], true)).toBe(false);
  expect(modelAllowed({ allowCustomModels: false }, ["claude"], false)).toBe(true);
});

test("sandbox: the stricter setting wins (allow lists intersect, deny lists union, whole-process beats per-command)", () => {
  user({ sandbox: { enabled: false, mode: "whole-process", filesystem: { allowWrite: ["/a/b", "/c"], denyRead: ["/u"] }, network: { allowedDomains: ["a.com", "b.com"] } } });
  org({ sandbox: { enabled: true, mode: "per-command", filesystem: { allowWrite: ["/a"], denyRead: ["/o"] }, network: { allowedDomains: ["a.com"], deniedDomains: ["evil.com"] } } });
  const sb = load().settings.sandbox!;
  expect(sb.enabled).toBe(true);
  expect(sb.mode).toBe("whole-process");
  expect(sb.filesystem?.allowWrite).toEqual(["/a/b"]);
  expect(sb.filesystem?.denyRead?.sort()).toEqual(["/o", "/u"]);
  expect(sb.network?.allowedDomains).toEqual(["a.com"]);
  expect(sb.network?.deniedDomains).toEqual(["evil.com"]);
});

test("hooks: org hooks run first; allowManagedHooksOnly drops every other hook", () => {
  mkdirSync(path.join(proj, ".rigwell"), { recursive: true });
  writeFileSync(path.join(proj, ".rigwell", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo project" }] }] } }));
  user({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo user" }] }] } });
  org({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo org" }] }] } });
  const all = loadHooksConfig({ cwd: proj, homeDir: home });
  expect(all.events.PreToolUse!.map((g) => g.hooks[0]!.command)).toEqual(["echo org", "echo project", "echo user"]);
  expect(all.events.PreToolUse![0]!.level).toBe("org");
  org({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo org" }] }] }, allowManagedHooksOnly: true });
  const only = loadHooksConfig({ cwd: proj, homeDir: home });
  expect(only.events.PreToolUse!.map((g) => g.hooks[0]!.command)).toEqual(["echo org"]);
});
