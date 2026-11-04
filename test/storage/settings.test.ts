import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "../../src/storage/settings.ts";
import { tmpEnv, writeJson } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => { env = tmpEnv(); });
afterEach(() => env.cleanup());

const set = (dir: string, name: string, v: unknown) => writeJson(path.join(dir, name), v);

test("builtin defaults", () => {
  const cwd = path.join(env.home, "w"); mkdirSync(cwd, { recursive: true });
  const r = loadSettings({ cwd, homeDir: env.home });
  expect(r.settings.sessionDefaultSettings).toEqual({ reasoningEffort: "high", autonomyLevel: "off", interactionMode: "auto" });
  expect(r.sources).toEqual([{ level: "builtin", path: "" }]);
});

test("precedence runtime > folder > project > user > builtin; local wins in a level; lists replace", () => {
  const repo = path.join(env.root, "repo");
  const cwd = path.join(repo, "pkg", "sub");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(path.join(repo, ".git"));
  set(env.rigwellHome, "settings.json", { sessionDefaultSettings: { autonomyLevel: "low", model: "u" }, commandAllowlist: ["u1", "u2"], compactionTokenLimit: 1 });
  set(path.join(repo, ".rigwell"), "settings.json", { sessionDefaultSettings: { autonomyLevel: "medium" }, compactionTokenLimit: 2, commandAllowlist: ["p"] });
  set(path.join(repo, ".rigwell"), "settings.local.json", { compactionTokenLimit: 3 });
  set(path.join(repo, "pkg", ".rigwell"), "settings.json", { sessionDefaultSettings: { reasoningEffort: "low" }, compactionTokenLimit: 4 });
  set(path.join(cwd, ".rigwell"), "settings.json", { compactionTokenLimit: 5 });
  set(path.join(cwd, ".rigwell"), "settings.local.json", { compactionTokenLimit: 6 });
  let r = loadSettings({ cwd, homeDir: env.home });
  expect(r.settings.compactionTokenLimit).toBe(6); // nearest folder, local
  expect(r.settings.sessionDefaultSettings).toEqual({ autonomyLevel: "medium", model: "u", reasoningEffort: "low", interactionMode: "auto" });
  expect(r.settings.commandAllowlist).toEqual(["p"]);
  expect(r.sources[0]).toEqual({ level: "folder", path: path.join(cwd, ".rigwell", "settings.local.json") });

  const rt = path.join(env.root, "rt.json");
  writeJson(rt, { compactionTokenLimit: 99, sessionDefaultSettings: { autonomyLevel: "high" } });
  r = loadSettings({ cwd, runtimeSettingsPath: rt, homeDir: env.home });
  expect(r.settings.compactionTokenLimit).toBe(99);
  expect(r.settings.sessionDefaultSettings?.autonomyLevel).toBe("high");
  expect(r.sources[0]!.level).toBe("runtime");
  expect(r.sources.map((s) => s.level)).toEqual(["runtime", "folder", "folder", "folder", "project", "project", "user", "builtin"]);
});

test("project at home dir (or containing it) is excluded; user level still read", () => {
  const cwd = path.join(env.home, "work"); mkdirSync(cwd, { recursive: true });
  set(path.join(env.home, ".rigwell"), "settings.json", { compactionTokenLimit: 1 }); // this is the user level
  mkdirSync(path.join(env.home, ".git"));
  // no cwd-level project config either; git root == home => no project
  set(path.join(env.home, "work", ".rigwell"), "settings.json", { compactionTokenLimit: 7 }); // folder level (cwd below git root)
  const r = loadSettings({ cwd, homeDir: env.home });
  expect(r.sources.some((s) => s.level === "project")).toBe(false);
  expect(r.settings.compactionTokenLimit).toBe(7);

  // cwd == home with no git: project root is home -> no project
  const r2 = loadSettings({ cwd: env.home, homeDir: env.home });
  expect(r2.sources.some((s) => s.level === "project")).toBe(false);
  expect(r2.settings.compactionTokenLimit).toBe(1);
});

test("non-git cwd: project is cwd/.rigwell; invalid JSON warns and is ignored", () => {
  const cwd = path.join(env.root, "plain"); mkdirSync(path.join(cwd, ".rigwell"), { recursive: true });
  writeFileSync(path.join(cwd, ".rigwell", "settings.json"), "{bad");
  set(path.join(cwd, ".rigwell"), "settings.local.json", { env: { A: "1" } });
  const r = loadSettings({ cwd, homeDir: env.home });
  expect(r.warnings.length).toBe(1);
  expect(r.settings.env).toEqual({ A: "1" });
  expect(r.sources[0]).toEqual({ level: "project", path: path.join(cwd, ".rigwell", "settings.local.json") });
});
