import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LESSONS } from "../../src/academy/catalog.ts";
import { checkPractice, createPracticeWorktree, listPractice, readPractice, removePractice, savePractice, startPractice } from "../../src/academy/practice.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { CLI } from "../e2e/helpers.ts";

test("the offline catalog retains all nine approved lessons", () => {
  expect(LESSONS.map((l) => l.id)).toEqual(["getting-started", "models-and-keys", "skills", "hooks", "mcp", "worktrees", "missions", "workstreams", "automations"]);
});

for (const lesson of LESSONS) test(`offline ${lesson.id} grades actual sample files, retains progress and leaves account settings untouched`, () => {
  const env = tmpEnv(); let id: string | undefined;
  try {
      const p = startPractice(lesson.id); id = p.id; expect(p.root).not.toContain(env.rigwellHome); expect(existsSync(join(p.root, ".git"))).toBe(true); expect(checkPractice(p.id).passed).toBe(false);
      savePractice(p.id, lesson.example); if (lesson.id === "worktrees") { const worktree = createPracticeWorktree(p.id); expect(existsSync(join(worktree.path, ".git"))).toBe(true); }
      const result = checkPractice(p.id); expect(result.passed).toBe(true); expect(result.message.length).toBeGreaterThan(15); expect(readPractice(p.id).passed).toBe(true);
      expect(listPractice().find((row) => row.id === p.id)?.passed).toBe(true); savePractice(p.id, lesson.starter); expect(readPractice(p.id).passed).toBe(false);
      expect(execFileSync("git", ["remote"], { cwd: p.root, encoding: "utf8", windowsHide: true }).trim()).toBe("");
    expect(existsSync(join(env.rigwellHome, "settings.json"))).toBe(false); expect(existsSync(join(env.rigwellHome, "automations"))).toBe(false); expect(existsSync(join(env.rigwellHome, "workstreams"))).toBe(false);
  } finally { if (id) removePractice(id, true); env.cleanup(); }
});

test("practice rejects links, corrupt ownership, arbitrary ids, unconfirmed removal and credentials without reading a credential store", () => {
  const env = tmpEnv(), practice = startPractice("models-and-keys"), marker = join(practice.root, ".academy-owned.json"), original = readFileSync(marker, "utf8");
  try {
    savePractice(practice.id, JSON.stringify({ provider: "generic-chat-completion-api", model: "local-model", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "keychain:must-not-look-up" })); expect(checkPractice(practice.id)).toEqual({ passed: false, message: "Use only provider, model, displayName and baseUrl; never enter credentials here." });
    expect(() => removePractice(practice.id, false)).toThrow("Confirm"); expect(() => readPractice("../outside")).toThrow("Invalid"); expect(existsSync(practice.root)).toBe(true);
    const outside = join(env.root, "untouched.json"); writeFileSync(outside, "preserve"); rmSync(join(practice.root, practice.file)); symlinkSync(outside, join(practice.root, practice.file), "file");
    expect(() => savePractice(practice.id, "changed")).toThrow("links"); expect(readFileSync(outside, "utf8")).toBe("preserve");
    writeFileSync(marker, JSON.stringify({ version: 1, id: "wrong", lesson: "models-and-keys", createdAt: "today" })); expect(() => removePractice(practice.id, true)).toThrow("marker"); expect(existsSync(practice.root)).toBe(true);
  } finally { writeFileSync(marker, original); removePractice(practice.id, true); env.cleanup(); }
});

test("sample Git ignores inherited routing and refuses a linked external Git directory", () => {
  const env = tmpEnv(), original = process.env.GIT_DIR; let id: string | undefined;
  try {
    const outside = join(env.root, "outside"); mkdirSync(outside); process.env.GIT_DIR = join(outside, ".git");
    const p = startPractice("worktrees"); id = p.id; expect(existsSync(join(outside, ".git"))).toBe(false);
    const saved = join(p.root, "saved-git"); const fs = require("node:fs"); fs.renameSync(join(p.root, ".git"), saved);
    symlinkSync(outside, join(p.root, ".git"), process.platform === "win32" ? "junction" : "dir");
    expect(() => createPracticeWorktree(p.id)).toThrow("links"); expect(existsSync(join(outside, "worktrees"))).toBe(false);
  } finally { if (original === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = original; if (id) removePractice(id, true); env.cleanup(); }
});

test("worktree checks accept canonical temporary paths and Windows short-name aliases", () => {
  const env = tmpEnv(), original = { TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR }; let id: string | undefined;
  try {
    const long = join(env.root, "Academy temporary directory"); mkdirSync(long); let temporary = long;
    if (process.platform === "win32") {
      const script = join(env.root, "short-path.ps1");
      writeFileSync(script, `param([string]$Target)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AcademyShortPath {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern uint GetShortPathName(string path, StringBuilder result, uint size);
}
'@
$buffer = New-Object Text.StringBuilder 32768
if ([AcademyShortPath]::GetShortPathName($Target, $buffer, 32768) -eq 0) { throw 'GetShortPathName failed' }
$buffer.ToString()
`);
      temporary = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, long], { encoding: "utf8", windowsHide: true }).trim();
    }
    process.env.TEMP = temporary; process.env.TMPDIR = temporary;
    const practice = startPractice("worktrees"); id = practice.id;
    expect(checkPractice(id).passed).toBe(false);
    createPracticeWorktree(id); savePractice(id, LESSONS.find((lesson) => lesson.id === "worktrees")!.example);
    expect(checkPractice(id).passed).toBe(true); expect(readPractice(id).passed).toBe(true);
  } finally {
    if (id) removePractice(id, true);
    for (const key of ["TEMP", "TMPDIR"] as const) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    env.cleanup();
  }
});

test("real learn CLI reads tutorials, creates/resumes/checks a sample and confirms cleanup", async () => {
  const env = tmpEnv(); let id: string | undefined;
  try {
    const run = async (args: string[], input?: string) => { const p = Bun.spawn([process.execPath, CLI, "learn", ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" }); const out = await new Response(p.stdout).text(), err = await new Response(p.stderr).text(); return { out, err, code: await p.exited }; };
    expect((await run(["list"])).out).toContain("workstreams: Workstreams"); expect((await run(["models-and-keys"])).out).toContain("Subscription access");
    const created = await run(["practice", "automations"]); expect(created.code).toBe(0); id = JSON.parse(created.out).id;
    expect((await run(["check", id!])).code).toBe(1); expect((await run(["save", id!], LESSONS.find((l) => l.id === "automations")!.example)).code).toBe(0); expect(JSON.parse((await run(["check", id!])).out).passed).toBe(true);
    expect((await run(["remove", id!])).code).toBe(2); expect((await run(["read", id!])).code).toBe(0); expect((await run(["remove", id!, "--yes"])).code).toBe(0); id = undefined;
  } finally { if (id) removePractice(id, true); env.cleanup(); }
});
