import { describe, expect, test } from "bun:test";
import type { ToolProgress } from "../../src/core/types.ts";
import * as fs from "node:fs";
import { createExecuteTool, pickShell } from "../../src/tools/execute.ts";
import { makeCtx, tmpDir } from "./helpers.ts";

const exec = createExecuteTool();

describe("Execute", () => {
  test("success runs in cwd, streams progress", async () => {
    const d = tmpDir();
    const prog: ToolProgress[] = [];
    // Git Bash on Windows prints /c/Users/... for pwd; `pwd -W` prints the Windows path (with forward slashes).
    const r = await exec.run({ command: "(pwd -W 2>/dev/null || pwd); echo err >&2" }, makeCtx(d, { onProgress: (p) => prog.push(p) }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("exit code: 0");
    if (process.platform === "win32") expect(r.content.toLowerCase()).toContain(fs.realpathSync.native(d).replace(/\\/g, "/").toLowerCase());
    else expect(r.content).toContain(d);
    expect(r.content).toContain("err");
    expect(prog.some((p) => p.text)).toBe(true);
    expect(prog.at(-1)?.exitCode).toBe(0);
  });
  test("nonzero exit is an error; stdin is closed", async () => {
    const d = tmpDir();
    const r = await exec.run({ command: "cat; exit 3" }, makeCtx(d));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit code: 3");
  });
  test("timeout kills the process group", async () => {
    const d = tmpDir();
    const t0 = Date.now();
    const r = await exec.run({ command: "sleep 30 & sleep 30", timeoutMs: 1000 }, makeCtx(d));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Timed out");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  test("abort signal stops the command", async () => {
    const ac = new AbortController();
    const p = exec.run({ command: "sleep 30" }, makeCtx(tmpDir(), { signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toContain("cancelled");
  });
  test("output is capped with head and tail", async () => {
    const r = await exec.run({ command: "head -c 100000 /dev/zero | tr '\\0' 'a'; echo; echo END" }, makeCtx(tmpDir()));
    expect(r.content).toContain("characters cut");
    expect(r.content).toContain("END");
    expect(r.content.length).toBeLessThan(31_000);
  });
  test("background is refused", async () => {
    const r = await exec.run({ command: "true", background: true }, makeCtx(tmpDir()));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not available");
  });
});

describe("Execute shell choice (spec 5, per platform)", () => {
  const none = () => undefined;
  test("POSIX: bash, else sh", () => {
    expect(pickShell("linux", (n) => (n === "bash" ? "/usr/bin/bash" : undefined)).name).toBe("bash");
    expect(pickShell("linux", (n) => (n === "sh" ? "/bin/sh" : undefined))).toMatchObject({ path: "/bin/sh", name: "/bin/sh" });
    expect(pickShell("darwin", (n) => (n === "bash" ? "/bin/bash" : undefined)).args("ls")).toEqual(["-c", "ls"]);
  });
  test("Windows: Git Bash on PATH wins; the WSL launcher is not used", () => {
    const gb = pickShell("win32", (n) => (n === "bash" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined));
    expect(gb).toMatchObject({ name: "bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" });
    expect(gb.args("echo hi")).toEqual(["-c", "echo hi"]);
    const wsl = pickShell("win32", (n) => (n === "bash" ? "C:\\Windows\\System32\\bash.exe" : n === "powershell" ? "C:\\ps\\powershell.exe" : undefined), () => false);
    expect(wsl.name).toBe("PowerShell");
  });
  test("Windows: Git Bash is found next to the git program, then PowerShell, then cmd", () => {
    const next = pickShell("win32", (n) => (n === "git" ? "C:\\Program Files\\Git\\cmd\\git.exe" : undefined), (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe");
    expect(next).toMatchObject({ name: "bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" });
    const ps = pickShell("win32", (n) => (n === "pwsh" ? "C:\\pwsh.exe" : undefined), () => false);
    expect(ps.args("Get-Date")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "Get-Date"]);
    const cmd = pickShell("win32", none, () => false, { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(cmd).toMatchObject({ name: "cmd.exe", path: "C:\\Windows\\System32\\cmd.exe" });
    expect(cmd.args("dir")).toEqual(["/d", "/s", "/c", "dir"]);
  });
});
