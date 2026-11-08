import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { daemonSocketPath } from "../../src/daemon/socket-path.ts";
import { doctorMain, findOnPath, formatReport, runDoctor } from "../../src/cli/doctor.ts";

const win = process.platform === "win32";
let root: string;
let saved: Record<string, string | undefined>;

/** Writes a tiny executable that prints `out` for any arguments. */
function fakeTool(dir: string, name: string, out: string, code = 0): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, win ? name + ".cmd" : name);
  writeFileSync(file, win ? `@echo off\r\necho ${out}\r\nexit /b ${code}\r\n` : `#!/bin/sh\necho "${out}"\nexit ${code}\n`);
  if (!win) chmodSync(file, 0o755);
  return file;
}

const base = () => {
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, PATH: "", Path: "", RIGWELL_HOME: home };
  return { home, env };
};
const setPath = (env: Record<string, string | undefined>, v: string) => { env.PATH = v; env.Path = v; };
const self = (code = 0) => {
  const f = path.join(root, `self${code}.js`);
  writeFileSync(f, `console.log("0.2.0"); process.exit(${code});`);
  return [process.execPath, f];
};
const status = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rw-doctor-"));
  saved = { RIGWELL_HOME: process.env.RIGWELL_HOME };
  process.env.RIGWELL_HOME = path.join(root, "home");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

describe("rigwell doctor", () => {
  test("a missing tool fails with an install hint; a present one passes with its version", async () => {
    const { home, env } = base();
    const bin = path.join(root, "bin");
    fakeTool(bin, "git", "git version 9.9.9");
    setPath(env, bin);
    const r = await runDoctor({ env, home, cwd: root, selfCmd: self(), version: "0.2.0" });
    expect(status(r, "git").status).toBe("pass");
    expect(status(r, "git").detail).toContain("9.9.9");
    const rg = status(r, "rg");
    expect(rg.status).toBe("fail");
    expect(rg.detail).toContain("not found on PATH");
    expect(rg.fix).toMatch(/winget install BurntSushi\.ripgrep\.MSVC|brew install ripgrep|apt install ripgrep/);
    expect(r.ok).toBe(false);
  });

  test("install hints follow the platform", async () => {
    const { home, env } = base();
    const mk = (platform: NodeJS.Platform) => runDoctor({ env, home, cwd: root, selfCmd: self(), platform });
    expect(status(await mk("win32"), "git").fix).toContain("winget install Git.Git");
    expect(status(await mk("darwin"), "git").fix).toContain("brew install git");
    expect(status(await mk("linux"), "rg").fix).toContain("apt install ripgrep");
  });

  test("findOnPath lists every copy in PATH order", () => {
    const a = path.join(root, "a"), b = path.join(root, "b");
    fakeTool(a, "rigwell", "0.1.0"); fakeTool(b, "rigwell", "0.2.0");
    const found = findOnPath([win ? "rigwell.cmd" : "rigwell"], { PATH: [a, b].join(path.delimiter) });
    expect(found.length).toBe(2);
    expect(found[0]!.startsWith(a)).toBe(true);
  });

  test("several rigwell copies, with differing versions, warn and list each version", async () => {
    const { home, env } = base();
    const a = path.join(root, "a"), b = path.join(root, "b");
    fakeTool(a, "rigwell", "0.1.0"); fakeTool(b, "rigwell", "0.2.0");
    setPath(env, [a, b].join(path.delimiter));
    const r = await runDoctor({ env, home, cwd: root, selfCmd: self(), version: "0.2.0" });
    const c = status(r, "copies");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("2 copies");
    expect(c.detail).toContain("differs");
    expect(c.items!.some((i) => i.includes("0.1.0"))).toBe(true);
    expect(c.items!.some((i) => i.includes("0.2.0"))).toBe(true);
  });

  test("a single copy at the running version passes", async () => {
    const { home, env } = base();
    const a = path.join(root, "a");
    fakeTool(a, "rigwell", "rigwell 0.2.0");
    setPath(env, a);
    const r = await runDoctor({ env, home, cwd: root, selfCmd: self(), version: "0.2.0" });
    expect(status(r, "copies").status).toBe("pass");
  });

  test("startup: a failing command fails, a good one passes, a slow one warns", async () => {
    const { home, env } = base();
    const bad = await runDoctor({ env, home, cwd: root, selfCmd: self(3) });
    expect(status(bad, "startup").status).toBe("fail");
    const good = await runDoctor({ env, home, cwd: root, selfCmd: self() });
    expect(status(good, "startup").status).toBe("pass");
    const slow = await runDoctor({ env, home, cwd: root, selfCmd: self(), slowStartMs: 0 });
    expect(status(slow, "startup").status).toBe("warn");
  });

  test("daemon: not running passes, a leftover socket file is stale, a live socket passes", async () => {
    const { home, env } = base();
    const none = await runDoctor({ env, home, cwd: root, selfCmd: self() });
    expect(status(none, "daemon").status).toBe("pass");
    const sock = daemonSocketPath(home);
    writeFileSync(sock, "");
    const stale = await runDoctor({ env, home, cwd: root, selfCmd: self(), connectTimeoutMs: 500 });
    expect(status(stale, "daemon").status).toBe("warn");
    expect(status(stale, "daemon").detail).toContain("stale");
    expect(status(stale, "daemon").detail).toContain(sock);
    expect(status(stale, "daemon").fix).toContain(sock);
    rmSync(sock);
    const server = Bun.listen({ unix: sock, socket: { data() {}, open() {} } });
    try {
      const live = await runDoctor({ env, home, cwd: root, selfCmd: self() });
      expect(status(live, "daemon").status).toBe("pass");
      expect(status(live, "daemon").detail).toContain("running");
    } finally { server.stop(true); }
  });

  test("a bad settings file and a bad mcp.json warn, and secrets are not printed", async () => {
    const { home, env } = base();
    writeFileSync(path.join(home, "settings.json"), `{ "customModels": [ {"model": "m1", "provider": "nope", "apiKey": "sk-supersecretvalue123456"} ], `);
    writeFileSync(path.join(home, "mcp.json"), `{ "mcpServers": { "ok": {"command": "x"}, "broken": {"type": "stdio"} } }`);
    const r = await runDoctor({ env, home, cwd: root, selfCmd: self() });
    const s = status(r, "settings");
    expect(s.status).toBe("warn");
    expect(s.items!.length).toBeGreaterThan(0);
    const m = status(r, "mcp");
    expect(m.status).toBe("warn");
    expect(m.detail).toContain("ok");
    expect(m.items!.join("\n")).toContain("broken");
    expect(JSON.stringify(r) + formatReport(r)).not.toContain("supersecretvalue");
  });

  test("an invalid custom model entry warns without printing its key", async () => {
    const { home, env } = base();
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ customModels: [{ model: "my-model", provider: "nope", apiKey: "sk-supersecretvalue123456" }] }));
    const r = await runDoctor({ env, home, cwd: root, selfCmd: self() });
    expect(status(r, "settings").status).toBe("warn");
    expect(status(r, "settings").items!.join("\n")).toContain("my-model");
    expect(JSON.stringify(r)).not.toContain("supersecretvalue");
  });

  test("exit code: 1 on any fail, 0 otherwise; --json prints the same data", async () => {
    const { home, env } = base();
    let out = "";
    const bin = path.join(root, "bin");
    expect(await doctorMain([], { env, home, cwd: root, selfCmd: self() }, (s) => { out += s; })).toBe(1);
    expect(out).toContain("[FAIL] git");
    expect(out).toContain("failure(s)");
    fakeTool(bin, "git", "git version 1"); fakeTool(bin, "rg", "ripgrep 14");
    setPath(env, bin);
    out = "";
    expect(await doctorMain(["--json"], { env, home, cwd: root, selfCmd: self() }, (s) => { out += s; })).toBe(0);
    const j = JSON.parse(out);
    expect(j.ok).toBe(true);
    expect(j.checks.map((c: any) => c.id)).toEqual(["git", "rg", "copies", "startup", "daemon", "settings", "hooks-skills", "mcp"]);
  });
});
