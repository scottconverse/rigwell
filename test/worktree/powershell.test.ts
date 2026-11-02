// Windows PowerShell runner (spec 18.3). This host is Linux: nothing here runs PowerShell. The tests drive runScript with
// platform "win32" and a fake spawner and assert the argv, env, script file and kill behaviour that would be used.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { pickPowerShell, planPowerShell, taskkillArgv, windowsScriptEnv, wrapScript } from "../../src/worktree/powershell.ts";
import { runScript, type ScriptSpawner } from "../../src/worktree/scripts.ts";

const streamOf = (s: string) => new ReadableStream<Uint8Array>({ start(c) { if (s) c.enqueue(new TextEncoder().encode(s)); c.close(); } });

function fakeSpawner(opts: { out?: string; err?: string; code?: number; hang?: boolean } = {}) {
  const calls: { argv: string[]; cwd: string; env: Record<string, string>; scriptText?: string; killed: number[] }[] = [];
  const spawner: ScriptSpawner = (argv, o) => {
    const call: (typeof calls)[number] = { argv, cwd: o.cwd, env: o.env, killed: [] };
    const scriptPath = argv[argv.indexOf("-File") + 1];
    if (scriptPath && existsSync(scriptPath)) call.scriptText = readFileSync(scriptPath, "utf8");
    calls.push(call);
    let release: (n: number) => void = () => {};
    const exited = new Promise<number>((r) => { release = r; });
    if (!opts.hang) release(opts.code ?? 0);
    return { pid: 4242, stdout: streamOf(opts.out ?? ""), stderr: streamOf(opts.err ?? ""), exited, kill: (s) => { call.killed.push(s ?? 15); release(1); } };
  };
  return { spawner, calls };
}

test("shell choice: pwsh when installed, else powershell.exe", () => {
  expect(pickPowerShell((n) => (n === "pwsh" ? "C:\\pwsh.exe" : null))).toBe("C:\\pwsh.exe");
  expect(pickPowerShell(() => null)).toBe("powershell.exe");
});

test("argv has -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>", () => {
  const plan = planPowerShell({ script: "echo hi", repoRoot: "C:\\repo", scriptPath: "C:\\t\\script.ps1", env: {}, which: () => null });
  expect(plan.argv).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\t\\script.ps1"]);
});

test("script wrapper: BOM, stop on error, CRLF, exit code of a failing native command", () => {
  const t = wrapScript("a\nb");
  expect(t.startsWith("\ufeff$ErrorActionPreference = 'Stop'\r\n")).toBe(true);
  expect(t).toContain("a\r\nb\r\n");
  expect(t).toContain("exit $LASTEXITCODE");
});

test("env: secrets stripped case-insensitively, Path kept as inherited, REPO_ROOT_PATH set", () => {
  const env = windowsScriptEnv({ Path: "C:\\bin", github_token: "x", My_Api_Key: "y", RIGWELL_HOME: "h", USERPROFILE: "C:\\u", Repo_Root_Path: "old", ssh_auth_sock: "s" }, "C:\\repo");
  expect(env).toEqual({ Path: "C:\\bin", USERPROFILE: "C:\\u", REPO_ROOT_PATH: "C:\\repo" });
});

test("runScript on win32: spawns the PowerShell argv in the worktree with the stripped env and a temp .ps1, then removes it", async () => {
  const { spawner, calls } = fakeSpawner({ out: "hello\n", code: 0 });
  const progress: string[] = [];
  const r = await runScript({
    script: "npm install\nWrite-Host done", cwd: "C:\\wt", repoRoot: "C:\\repo", timeoutMs: 5000, platform: "win32", spawner, which: () => null,
    env: { EXTRA: "1", DB_PASSWORD: "no" }, onProgress: (t) => progress.push(t),
  });
  expect(r).toEqual({ ok: true, code: 0, timedOut: false, output: "hello\n" });
  expect(progress.join("")).toBe("hello\n");
  const c = calls[0]!;
  expect(c.argv.slice(0, 6)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  expect(c.argv[6]).toMatch(/script\.ps1$/);
  expect(c.cwd).toBe("C:\\wt");
  expect(c.env.REPO_ROOT_PATH).toBe("C:\\repo");
  expect(c.env.EXTRA).toBe("1");
  expect(c.env.DB_PASSWORD).toBeUndefined();
  expect(c.scriptText).toContain("npm install\r\nWrite-Host done");
  expect(existsSync(c.argv[6]!)).toBe(false); // temp script removed
});

test("runScript on win32: a nonzero exit is reported; a timeout runs taskkill /T /F and kills", async () => {
  const bad = fakeSpawner({ code: 3, err: "boom" });
  expect(await runScript({ script: "exit 3", cwd: ".", repoRoot: "r", timeoutMs: 5000, platform: "win32", spawner: bad.spawner, which: () => null })).toMatchObject({ ok: false, code: 3, output: "boom" });

  const slow = fakeSpawner({ hang: true });
  const r = await runScript({ script: "Start-Sleep 60", cwd: ".", repoRoot: "r", timeoutMs: 30, platform: "win32", spawner: slow.spawner, which: () => null });
  expect(r).toMatchObject({ ok: false, code: null, timedOut: true });
  expect(slow.calls[1]!.argv).toEqual(taskkillArgv(4242));
  expect(slow.calls[0]!.killed).toEqual([9]);
});

test("runScript on linux ignores the PowerShell path (bash -c, PATH from the login shell)", async () => {
  const { spawner, calls } = fakeSpawner();
  await runScript({ script: "echo x", cwd: ".", repoRoot: "/r", timeoutMs: 5000, platform: "linux", spawner });
  expect(calls[0]!.argv.slice(1)).toEqual(["-c", "echo x"]);
  expect(calls[0]!.env.REPO_ROOT_PATH).toBe("/r");
});
