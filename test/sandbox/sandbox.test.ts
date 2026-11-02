import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPolicy, buildSeatbeltProfile, detectEngine, domainAllowed, mergeSandboxOrg, sandboxFor, sandboxStatusLabel, ViolationLog,
  MAX_VIOLATIONS, type SandboxSettings, type SandboxViolation, detectFromStderr, detectDeniedReads,
} from "../../src/sandbox/index.ts";
import { createExecuteTool } from "../../src/tools/execute.ts";
import { makeCtx } from "../tools/helpers.ts";

// Platform gating: the engine tests need a working bubblewrap (Linux). They are skipped, with a printed
// reason, only when it is genuinely unavailable on the machine running the suite.
const engine = detectEngine();
const linux = engine.engine === "bubblewrap" && engine.available;
if (!linux) console.log(`[sandbox tests] bubblewrap engine tests skipped: ${engine.reason ?? "not Linux"}`);
const linuxTest = linux ? test : test.skip;
const proxyTest = linux && engine.canProxy ? test : test.skip;
if (linux && !engine.canProxy) console.log("[sandbox tests] proxy tests skipped: socat is not installed");

// /var/tmp is not remounted by the sandbox (/tmp is a private tmpfs inside it), so it serves as "outside".
const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "rigwell-sbx-test-")));
const oldHome = process.env.RIGWELL_HOME;
let n = 0;
const sid = () => `sbx-test-${process.pid}-${n++}`;

function mk(name: string) {
  const d = path.join(root, `${name}-${n++}`);
  const cwd = path.join(d, "work");
  const home = path.join(d, "home");
  const rhome = path.join(home, ".rigwell");
  const outside = path.join(d, "outside");
  for (const p of [cwd, path.join(home, ".ssh"), rhome, outside]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "FAKE-PRIVATE-KEY\n");
  fs.writeFileSync(path.join(rhome, "credentials.json"), '{"k":"FAKE-TOKEN"}');
  fs.mkdirSync(path.join(rhome, "certs"));
  process.env.RIGWELL_HOME = rhome;
  return { cwd, home, rhome, outside };
}

function setup(t: ReturnType<typeof mk>, settings: SandboxSettings, ask?: (p: Record<string, unknown>) => Promise<{ selectedOption: string }>) {
  const id = sid();
  process.env.RIGWELL_HOME = t.rhome;
  // Settings come from the real user settings file so that "allow always" persistence is exercised.
  const c = sandboxFor(id, { home: t.home, ask, settings: () => ({ ...settings, ...readUser(t.rhome) }) });
  return { id, c, ctx: makeCtx(t.cwd, { sessionId: id, toolUseId: "tu1" }) };
}
function readUser(rhome: string): SandboxSettings | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(rhome, "settings.json"), "utf8")).sandbox;
  } catch {
    return undefined;
  }
}
const exec = createExecuteTool();
const on: SandboxSettings = { enabled: true, mode: "per-command" };

afterAll(() => {
  if (oldHome === undefined) delete process.env.RIGWELL_HOME;
  else process.env.RIGWELL_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("status and platform reporting", () => {
  test("Windows reports unavailable; commands rely on the permission rules", async () => {
    const eng = detectEngine({ platform: "win32" });
    expect(eng.available).toBe(false);
    expect(eng.reason).toContain("win32");
    const c = sandboxFor(sid(), { platform: "win32", settings: () => on });
    const st = c.status(root);
    expect(st).toMatchObject({ enabled: true, mode: "per-command", active: false, available: false, engine: "none" });
    expect(sandboxStatusLabel(st)).toContain("unavailable");
    const run = await c.prepare({ shell: "/bin/sh", command: "echo hi", cwd: root });
    expect(run.error).toBeUndefined();
    expect(run.file).toBe("/bin/sh");
  });
  test("Linux without bubblewrap fails closed", async () => {
    const c = sandboxFor(sid(), { platform: "linux", which: () => undefined, settings: () => on });
    expect(c.status(root).available).toBe(false);
    const run = await c.prepare({ shell: "/bin/sh", command: "echo hi", cwd: root });
    expect(run.error).toContain("unavailable");
  });
  test("bubblewrap that cannot create a sandbox is unavailable, socat enables the proxy", () => {
    const bad = detectEngine({ platform: "linux", which: (c) => `/usr/bin/${c}`, probeBwrap: () => "no user namespaces" });
    expect(bad.available).toBe(false);
    const good = detectEngine({ platform: "linux", which: (c) => `/usr/bin/${c}`, probeBwrap: () => undefined });
    expect(good).toMatchObject({ available: true, canProxy: true });
    const nosocat = detectEngine({ platform: "linux", which: (c) => (c === "bwrap" ? "/usr/bin/bwrap" : undefined), probeBwrap: () => undefined });
    expect(nosocat).toMatchObject({ available: true, canProxy: false });
  });
  test("macOS uses sandbox-exec; disabled sandbox is just reported", () => {
    expect(detectEngine({ platform: "darwin", which: () => "/usr/bin/sandbox-exec" })).toMatchObject({ engine: "sandbox-exec", available: true });
    const c = sandboxFor(sid(), { settings: () => ({ enabled: false }) });
    expect(c.status(root).enabled).toBe(false);
    expect(sandboxStatusLabel(c.status(root))).toBe("off");
    // whole-process needs bubblewrap: on macOS it is reported and commands stay per command
    const wp = sandboxFor(sid(), { platform: "darwin", which: () => "/usr/bin/sandbox-exec", settings: () => ({ enabled: true, mode: "whole-process" }) }).status(root);
    expect(wp.mode).toBe("whole-process");
    expect(wp.note).toContain("per command");
  });
  test("seatbelt profile denies writes, credentials and network by default", () => {
    const t = mk("sb");
    const pol = buildPolicy({ cwd: t.cwd, home: t.home, rigwellHome: t.rhome, settings: on, canProxy: true });
    const prof = buildSeatbeltProfile(pol);
    expect(prof).toContain("(deny file-write*)");
    expect(prof).toContain(`(subpath "${t.cwd}")`);
    expect(prof).toContain("(deny file-read*");
    expect(prof).toContain(`${t.home}/.ssh`);
    expect(prof).toContain("(deny network*)");
    const allowed = buildPolicy({ cwd: t.cwd, home: t.home, rigwellHome: t.rhome, settings: { enabled: true, network: { allowedDomains: ["a.test"] } }, canProxy: true });
    expect(buildSeatbeltProfile(allowed, 4567)).toContain('(remote ip "localhost:4567")');
  });
});

describe("policy", () => {
  test("org merge: stricter wins", () => {
    const org: SandboxSettings = {
      enabled: true, mode: "whole-process",
      filesystem: { allowWrite: ["/work"], denyRead: ["/secret"] },
      network: { allowedDomains: ["a.test", "b.test"], deniedDomains: ["evil.test"], allowLocalBinding: false },
    };
    const user: SandboxSettings = {
      enabled: false, mode: "per-command",
      filesystem: { allowWrite: ["/work/sub", "/other"], denyRead: ["/mine"] },
      network: { allowedDomains: ["b.test", "c.test"], deniedDomains: ["bad.test"], allowLocalBinding: true },
    };
    const m = mergeSandboxOrg(org, user);
    expect(m.enabled).toBe(true);
    expect(m.mode).toBe("whole-process");
    expect(m.filesystem?.allowWrite).toEqual(["/work/sub"]);
    expect(m.filesystem?.denyRead?.sort()).toEqual(["/mine", "/secret"]);
    expect(m.network?.allowedDomains).toEqual(["b.test"]);
    expect(m.network?.deniedDomains?.sort()).toEqual(["bad.test", "evil.test"]);
    expect(m.network?.allowLocalBinding).toBe(false);
    expect(mergeSandboxOrg(undefined, user)).toEqual(user);
    expect(mergeSandboxOrg({ network: { allowedDomains: ["*"] } }, { network: { allowedDomains: ["x.test"] } }).network?.allowedDomains).toEqual(["x.test"]);
  });
  test("domain matching: deny list beats allow list, wildcard subdomains", () => {
    expect(domainAllowed("api.a.test", ["*.a.test"], [])).toEqual({ ok: true });
    expect(domainAllowed("a.test", ["*.a.test"], [])).toEqual({ ok: false, reason: "not-allowed" });
    expect(domainAllowed("a.test", ["*"], ["a.test"])).toEqual({ ok: false, reason: "deny-list" });
  });
  test("network rule: none by default, proxy for a list, all for '*'", () => {
    const t = mk("pol");
    const base = { cwd: t.cwd, home: t.home, rigwellHome: t.rhome, canProxy: true };
    expect(buildPolicy({ ...base, settings: on }).network.rule).toBe("none");
    expect(buildPolicy({ ...base, settings: { network: { allowedDomains: ["a.test"] } } }).network.rule).toBe("proxy");
    expect(buildPolicy({ ...base, settings: { network: { allowedDomains: ["*"] } } }).network.rule).toBe("all");
    expect(buildPolicy({ ...base, settings: { network: { allowedDomains: ["*"], deniedDomains: ["x.test", "*"] } } }).network).toMatchObject({ rule: "proxy", deniedDomains: ["x.test"] });
    expect(buildPolicy({ ...base, canProxy: false, settings: { network: { allowedDomains: ["a.test"] } } }).network.rule).toBe("none");
  });
  test("credentials stay unreadable even if allowRead names them", () => {
    const t = mk("cred");
    const p = buildPolicy({ cwd: t.cwd, home: t.home, rigwellHome: t.rhome, canProxy: false, settings: { filesystem: { allowRead: [path.join(t.home, ".ssh")] } } });
    expect(p.readAllowed).toEqual([]);
    expect(p.unreadable).toContain(path.join(t.home, ".ssh"));
    expect(p.readOnly).toContain(path.join(t.rhome, "certs"));
    expect(p.writable).toContain(t.rhome);
  });
});

describe("violation detection and log", () => {
  test("log keeps the newest 500", () => {
    const log = new ViolationLog();
    for (let i = 0; i < MAX_VIOLATIONS + 25; i++) log.push({ type: "network", reason: "not-allowed", target: `h${i}`, command: "x", at: i });
    expect(log.size).toBe(MAX_VIOLATIONS);
    expect(log.list()[0]!.target).toBe("h25");
  });
  test("stderr and command text detection", () => {
    const t = mk("det");
    const pol = buildPolicy({ cwd: t.cwd, home: t.home, rigwellHome: t.rhome, canProxy: false, settings: on });
    const out = path.join(t.outside, "f");
    const v = detectFromStderr(`touch: cannot touch '${out}': Read-only file system\ncat: x: Permission denied\n`, pol, t.cwd, "touch");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ type: "filesystem-write", reason: "not-allowed", target: out });
    const inCwd = detectFromStderr(`bash: ${t.cwd}/f: Permission denied`, pol, t.cwd, "x");
    expect(inCwd).toHaveLength(0);
    const r = detectDeniedReads("cat ~/.ssh/id_rsa && ls $HOME/.sshx", pol, t.home);
    expect(r.map((x) => x.target)).toEqual([path.join(t.home, ".ssh")]);
    expect(r[0]).toMatchObject({ type: "filesystem-read", reason: "deny-list" });
  });
});

describe("Execute under bubblewrap", () => {
  linuxTest("write inside the working folder is allowed, outside is blocked and reported", async () => {
    const t = mk("w");
    const { ctx, c } = setup(t, on);
    const okRun = await exec.run({ command: "echo hi > inside.txt && cat inside.txt" }, ctx);
    expect(okRun.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(t.cwd, "inside.txt"), "utf8")).toBe("hi\n");
    const bad = path.join(t.outside, "nope.txt");
    const r = await exec.run({ command: `echo x > ${bad}` }, ctx);
    expect(r.isError).toBe(true);
    expect(fs.existsSync(bad)).toBe(false);
    expect(r.content).toContain("Sandbox blocked: write to");
    expect(r.content).toContain(bad);
    expect(c.violations.list()[0]).toMatchObject({ type: "filesystem-write", reason: "not-allowed", target: bad });
  });
  linuxTest("rigwell state folder is writable, certs and credential files are not", async () => {
    const t = mk("state");
    const { ctx } = setup(t, on);
    const r1 = await exec.run({ command: `echo s > ${t.rhome}/state.json` }, ctx);
    expect(r1.isError).toBeFalsy();
    const r2 = await exec.run({ command: `echo s > ${t.rhome}/certs/ca.pem` }, ctx);
    expect(r2.isError).toBe(true);
    expect(fs.existsSync(path.join(t.rhome, "certs", "ca.pem"))).toBe(false);
    const r3 = await exec.run({ command: `echo s > ${t.rhome}/credentials.json` }, ctx);
    expect(r3.isError).toBe(true);
    expect(fs.readFileSync(path.join(t.rhome, "credentials.json"), "utf8")).toContain("FAKE-TOKEN");
  });
  linuxTest("reading a credential file is blocked", async () => {
    const t = mk("r");
    const { ctx, c } = setup(t, on);
    const r = await exec.run({ command: `cat ${t.home}/.ssh/id_rsa; cat ${t.rhome}/credentials.json` }, ctx);
    expect(r.content).not.toContain("FAKE-PRIVATE-KEY");
    expect(r.content).not.toContain("FAKE-TOKEN");
    expect(r.content).toContain("Sandbox blocked: read of");
    expect(c.violations.list().some((v) => v.type === "filesystem-read" && v.target.endsWith(".ssh"))).toBe(true);
    // Other files in the same home stay readable.
    fs.writeFileSync(path.join(t.home, "plain.txt"), "PLAIN");
    const ok = await exec.run({ command: `cat ${t.home}/plain.txt` }, ctx);
    expect(ok.content).toContain("PLAIN");
  });
  linuxTest("network is blocked unless allowed", async () => {
    const t = mk("net");
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const cmd = `exec 3<>/dev/tcp/127.0.0.1/${srv.port} && echo CONNECTED`;
      const open = setup(t, { enabled: false });
      const r0 = await exec.run({ command: `bash -c '${cmd}'` }, open.ctx);
      expect(r0.content).toContain("CONNECTED");
      const { ctx } = setup(t, on);
      const r = await exec.run({ command: `bash -c '${cmd}'` }, ctx);
      expect(r.content).not.toContain("CONNECTED");
      expect(r.isError).toBe(true);
      const all = setup(t, { enabled: true, network: { allowedDomains: ["*"] } });
      const r2 = await exec.run({ command: `bash -c '${cmd}'` }, all.ctx);
      expect(r2.content).toContain("CONNECTED");
    } finally {
      srv.stop(true);
    }
  });
  proxyTest("domain allow-list goes through the proxy; other hosts are blocked and reported", async () => {
    const t = mk("proxy");
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const { ctx, c } = setup(t, { enabled: true, network: { allowedDomains: ["localhost"] } });
      const good = await exec.run({ command: `curl -s --max-time 5 http://localhost:${srv.port}/` }, ctx);
      expect(good.content).toContain("pong");
      expect(c.violations.size).toBe(0);
      const bad = await exec.run({ command: `curl -s --max-time 5 http://127.0.0.1:${srv.port}/` }, ctx);
      expect(bad.content).not.toContain("pong");
      expect(bad.content).toContain("Blocked by the Rigwell sandbox");
      expect(c.violations.list().at(-1)).toMatchObject({ type: "network", reason: "not-allowed", target: "127.0.0.1" });
      // Direct sockets that ignore the proxy have no route at all.
      const direct = await exec.run({ command: `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${srv.port} && echo CONNECTED'` }, ctx);
      expect(direct.content).not.toContain("CONNECTED");
    } finally {
      srv.stop(true);
    }
  });
  proxyTest("a denied domain beats '*'", async () => {
    const t = mk("deny");
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const { ctx, c } = setup(t, { enabled: true, network: { allowedDomains: ["*"], deniedDomains: ["localhost"] } });
      const r = await exec.run({ command: `curl -s --max-time 5 http://localhost:${srv.port}/` }, ctx);
      expect(r.content).not.toContain("pong");
      expect(c.violations.list().at(-1)).toMatchObject({ type: "network", reason: "deny-list", target: "localhost" });
      const other = await exec.run({ command: `curl -s --max-time 5 http://127.0.0.1:${srv.port}/` }, ctx);
      expect(other.content).toContain("pong");
    } finally {
      srv.stop(true);
    }
  });
});

describe("violation prompt and 'allow always'", () => {
  type Req = { toolUses: { confirmationType: string; details: Record<string, unknown>; toolUse: { name: string } }[]; options: { label: string; value: string }[] };

  linuxTest("write violation prompts with the 5.5.5 options; allow always (parent dir) persists to user settings", async () => {
    const t = mk("ask");
    const reqs: Req[] = [];
    const { ctx } = setup(t, on, async (p) => {
      reqs.push(p as unknown as Req);
      return { selectedOption: "proceed_always" };
    });
    const target = path.join(t.outside, "deep", "f.txt");
    fs.mkdirSync(path.dirname(target));
    const r = await exec.run({ command: `echo x > ${target}` }, ctx);
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(req.toolUses[0]!.confirmationType).toBe("sandbox_violation");
    expect(req.toolUses[0]!.details).toMatchObject({ type: "filesystem-write", reason: "not-allowed", target, blocked: true, title: "Sandbox Violation" });
    const labels = req.options.map((o) => o.label);
    expect(labels).toContain(`Allow always (writes to ${path.dirname(target)})`);
    expect(labels).toContain(`Allow always (writes to ${target})`);
    expect(req.options.map((o) => o.value)).toEqual(expect.arrayContaining(["proceed_always", "proceed_always_file", "proceed_once", "cancel"]));
    expect(r.content).toContain("saved");
    const saved = JSON.parse(fs.readFileSync(path.join(t.rhome, "settings.json"), "utf8"));
    expect(saved.sandbox.filesystem.allowWrite).toEqual([path.dirname(target)]);
    // The next run, with the saved setting, now writes.
    const again = await exec.run({ command: `echo x > ${target} && echo done` }, ctx);
    expect(again.isError).toBeFalsy();
    expect(fs.readFileSync(target, "utf8")).toBe("x\n");
  });
  linuxTest("allow always (exact path) saves only that file's path; cancel stays blocked and is not re-asked", async () => {
    const t = mk("ask2");
    let choice = "proceed_always_file";
    let asked = 0;
    const { ctx } = setup(t, on, async () => {
      asked++;
      return { selectedOption: choice };
    });
    const f = path.join(t.outside, "one.txt");
    await exec.run({ command: `echo x > ${f}` }, ctx);
    expect(JSON.parse(fs.readFileSync(path.join(t.rhome, "settings.json"), "utf8")).sandbox.filesystem.allowWrite).toEqual([f]);
    choice = "cancel";
    const g = path.join(t.outside, "two.txt");
    const r = await exec.run({ command: `echo x > ${g}` }, ctx);
    expect(r.content).toContain("It stays blocked");
    expect(fs.existsSync(g)).toBe(false);
    await exec.run({ command: `echo x > ${g}` }, ctx);
    expect(asked).toBe(2);
  });
  linuxTest("a mention of a denied read path prompts for reads; credential files are never offered", async () => {
    const t = mk("ask3");
    const reqs: Req[] = [];
    const { ctx } = setup(t, { enabled: true, filesystem: { denyRead: [path.join(t.outside, "private")] } }, async (p) => {
      reqs.push(p as unknown as Req);
      return { selectedOption: "proceed_once" };
    });
    fs.mkdirSync(path.join(t.outside, "private"));
    fs.writeFileSync(path.join(t.outside, "private", "a.txt"), "SECRET-A");
    const r = await exec.run({ command: `cat ${t.outside}/private/a.txt; cat ${t.home}/.ssh/id_rsa` }, ctx);
    expect(r.content).not.toContain("SECRET-A");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.toolUses[0]!.details).toMatchObject({ type: "filesystem-read", reason: "deny-list" });
    expect(reqs[0]!.options.map((o) => o.label)).toContain(`Remove ${path.join(t.outside, "private")} from deny list`);
    expect(r.content).toContain("protected path and cannot be allowed");
  });
  proxyTest("network violation: allow always saves the domain", async () => {
    const t = mk("ask4");
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const reqs: Req[] = [];
      const { ctx } = setup(t, { enabled: true, network: { allowedDomains: ["example.invalid"] } }, async (p) => {
        reqs.push(p as unknown as Req);
        return { selectedOption: "proceed_always" };
      });
      await exec.run({ command: `curl -s --max-time 5 http://localhost:${srv.port}/` }, ctx);
      expect(reqs[0]!.toolUses[0]!.details).toMatchObject({ type: "network", target: "localhost" });
      expect(reqs[0]!.options.map((o) => o.label)).toContain("Allow always (localhost)");
      const saved = JSON.parse(fs.readFileSync(path.join(t.rhome, "settings.json"), "utf8"));
      expect(saved.sandbox.network.allowedDomains).toEqual(["localhost"]);
      const r = await exec.run({ command: `curl -s --max-time 5 http://localhost:${srv.port}/` }, ctx);
      expect(r.content).toContain("pong");
    } finally {
      srv.stop(true);
    }
  });
  test("violation type is the spec vocabulary", () => {
    const v: SandboxViolation = { type: "tool", reason: "deny-list", target: "x", command: "c", at: 0 };
    expect(["filesystem-read", "filesystem-write", "network", "tool"]).toContain(v.type);
  });
});
