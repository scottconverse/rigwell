import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { InstructionLoader, renderInstructions } from "../../src/instructions/index.ts";

let env: ReturnType<typeof tmpEnv>;
let proj: string;
beforeEach(() => { env = tmpEnv(); proj = path.join(env.root, "proj"); mkdirSync(path.join(proj, ".git"), { recursive: true }); });
afterEach(() => env.cleanup());

const w = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const mk = (cwd = proj, extra: object = {}) => new InstructionLoader({ cwd, homeDir: env.home, ...extra });

test("none found => null block", () => {
  const r = mk().load();
  expect(r.files).toEqual([]);
  expect(r.block).toBeNull();
});

test("walk cwd to git root nearest first, subfolders, personal last, CLAUDE.md before AGENTS.md", () => {
  const sub = path.join(proj, "a", "b");
  mkdirSync(sub, { recursive: true });
  w(path.join(proj, "AGENTS.md"), "root agents");
  w(path.join(proj, "a", "AGENTS.md"), "a agents");
  w(path.join(proj, "a", "CLAUDE.md"), "a claude");
  w(path.join(sub, ".rigwell", "agents.md"), "b hidden");
  w(path.join(sub, ".agents", "AGENTS.md"), "b agents-dir");
  w(path.join(env.rigwellHome, "AGENTS.md"), "personal");
  w(path.join(env.root, "outside", "AGENTS.md"), "outside repo");
  const r = mk(sub).load();
  expect(r.files.map((f) => f.path)).toEqual(["a/b/.rigwell/agents.md", "a/b/.agents/AGENTS.md", "a/CLAUDE.md", "AGENTS.md", "~/.rigwell/AGENTS.md"]);
  expect(r.files[2].content).toBe("a claude"); // AGENTS.md in the same folder is not loaded
  expect(r.block).toContain("<project_instructions>");
  expect(r.block).toContain('<file path="a/CLAUDE.md">\na claude\n</file>');
  expect(r.block).toContain('<file path="~/.rigwell/AGENTS.md">');
});

test("outside a repo only cwd; home folder itself is skipped; duplicates by realpath load once", () => {
  const plain = path.join(env.root, "plain");
  w(path.join(plain, "AGENTS.md"), "plain");
  w(path.join(env.root, "AGENTS.md"), "parent, not visited");
  expect(mk(plain).load().files.map((f) => f.content)).toEqual(["plain"]);
  w(path.join(env.home, "AGENTS.md"), "home file");
  expect(mk(env.home).load().files).toEqual([]); // cwd == home: skipped, personal dir is .rigwell
  // same file via symlinked subfolder
  w(path.join(proj, "real", "AGENTS.md"), "real");
  symlinkSync(path.join(proj, "real"), path.join(proj, ".agents"), process.platform === "win32" ? "junction" : "dir");
  const r = mk(path.join(proj, "real")).load();
  expect(r.files.length).toBe(1);
});

test("symlink rules: inside project .md ok, outside / non-md / broken skipped with notes; personal may link anywhere", () => {
  w(path.join(env.root, "outside.md"), "outside content");
  w(path.join(proj, "inside.md"), "inside content");
  w(path.join(proj, "notes.txt"), "txt");
  const sub = (n: string) => { mkdirSync(path.join(proj, n), { recursive: true }); return path.join(proj, n, "AGENTS.md"); };
  symlinkSync(path.join(proj, "inside.md"), sub("ok"));
  symlinkSync(path.join(env.root, "outside.md"), sub("out"));
  symlinkSync(path.join(proj, "notes.txt"), sub("txt"));
  symlinkSync(path.join(proj, "missing.md"), sub("broken"));
  const loader = mk(proj);
  loader.load();
  for (const n of ["ok", "out", "txt", "broken"]) loader.discoverForPath(path.join(proj, n, "x"));
  const pending = loader.takePending()!;
  expect(pending).toContain('<file path="ok/AGENTS.md">\ninside content');
  expect(pending).toContain("not loaded: link points outside the project");
  expect(pending).toContain("not loaded: link does not point at a .md file");
  expect(pending).toContain("not loaded: broken link");
  // personal link outside the home is fine
  symlinkSync(path.join(env.root, "outside.md"), path.join(env.rigwellHome, "AGENTS.md"));
  expect(mk(proj).load().files.map((f) => f.content)).toEqual(["outside content"]);
});

test("budget: file crossing the limit is cut with a note when >200 chars remain; loading then stops", () => {
  w(path.join(proj, "sub", "AGENTS.md"), "a".repeat(300));
  w(path.join(proj, "AGENTS.md"), "b".repeat(500));
  w(path.join(env.rigwellHome, "AGENTS.md"), "never");
  const r = mk(path.join(proj, "sub"), { totalBudget: 700 }).load();
  expect(r.files.map((f) => [f.path, f.truncated])).toEqual([["sub/AGENTS.md", false], ["AGENTS.md", true]]);
  expect(r.files[1].shownChars).toBe(400);
  expect(r.budgetExhausted).toBe(true);
  expect(r.block).toContain('<file path="AGENTS.md" truncated="true" shown_chars="400">');
  expect(r.block).toContain("[truncated: instruction budget reached]");
  // <= 200 chars of room: the file is dropped, loading stops
  const r2 = mk(path.join(proj, "sub"), { totalBudget: 450 }).load();
  expect(r2.files.map((f) => f.path)).toEqual(["sub/AGENTS.md"]);
});

test("lazy discovery: deeper folders, once, reminder block, reset after compaction", () => {
  w(path.join(proj, "AGENTS.md"), "root");
  w(path.join(proj, "pkg", "AGENTS.md"), "pkg rules");
  w(path.join(proj, "pkg", "deep", ".rigwell", "CLAUDE.md"), "deep rules");
  w(path.join(proj, "pkg", "deep", "x.ts"), "code");
  const l = mk(proj);
  expect(l.load().files.map((f) => f.path)).toEqual(["AGENTS.md"]);
  const found = l.discoverForPath(path.join(proj, "pkg", "deep", "x.ts"));
  expect(found.map((f) => f.path)).toEqual(["pkg/AGENTS.md", "pkg/deep/.rigwell/CLAUDE.md"]);
  expect(l.discoverForPath(path.join(proj, "pkg", "deep", "x.ts"))).toEqual([]);
  expect(l.hasPending()).toBe(true);
  expect(l.takePending()).toContain("pkg rules");
  expect(l.takePending()).toBeNull();
  expect(l.discoverForPath("/etc/hosts")).toEqual([]);
  l.afterCompaction();
  expect(l.discoverForPath(path.join(proj, "pkg", "deep", "x.ts")).length).toBe(2);
});

test("lazy discovery respects 40,000 char pass budget", () => {
  w(path.join(proj, "p1", "AGENTS.md"), "x".repeat(39_900));
  w(path.join(proj, "p1", "p2", "AGENTS.md"), "y".repeat(5_000));
  const l = mk(proj); l.load();
  const f = l.discoverForPath(path.join(proj, "p1", "p2", "z"));
  expect(f.map((x) => x.truncated)).toEqual([false]); // 100 chars of room left (<=200): second dropped
});

test("renderInstructions", () => {
  expect(renderInstructions([])).toBeNull();
  expect(renderInstructions([{ path: "A.md", absPath: "/A.md", content: "hi", truncated: false, shownChars: 2, personal: false }]))
    .toContain('<file path="A.md">\nhi\n</file>');
});
