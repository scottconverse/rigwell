// Wave 3 sandbox: the seccomp filter and whole-process mode (spec 5.5.8). Engine tests need a working bubblewrap.
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSeccompProgram, deniedSyscalls, detectEngine, mergeSandboxOrg, policyHash, sandboxFor, sandboxStatusLabel, seccompArch, seccompFile, type SandboxSettings } from "../../src/sandbox/index.ts";
import { createExecuteTool } from "../../src/tools/execute.ts";
import { makeCtx } from "../tools/helpers.ts";

const engine = detectEngine();
const linux = engine.engine === "bubblewrap" && engine.available;
if (!linux) console.log(`[sandbox wave3 tests] bubblewrap engine tests skipped: ${engine.reason ?? "not Linux"}`);
const linuxTest = linux ? test : test.skip;
const proxyTest = linux && engine.canProxy ? test : test.skip;

const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "rigwell-sbx3-")));
const oldHome = process.env.RIGWELL_HOME;
let n = 0;
afterAll(() => {
  if (oldHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function mk(name: string) {
  const d = path.join(root, `${name}-${n++}`);
  const cwd = path.join(d, "work");
  const home = path.join(d, "home");
  const rhome = path.join(home, ".rigwell");
  const outside = path.join(d, "outside");
  for (const p of [cwd, path.join(home, ".ssh"), rhome, outside]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "FAKE-PRIVATE-KEY\n");
  process.env.RIGWELL_HOME = rhome;
  return { cwd, home, rhome, outside };
}
function setup(t: ReturnType<typeof mk>, settings: () => SandboxSettings, ask?: (p: Record<string, unknown>) => Promise<{ selectedOption: string }>) {
  const id = `sbx3-${process.pid}-${n++}`;
  process.env.RIGWELL_HOME = t.rhome;
  const c = sandboxFor(id, { home: t.home, ask, settings });
  return { id, c, ctx: makeCtx(t.cwd, { sessionId: id, toolUseId: "tu" }) };
}
const exec = createExecuteTool();

// ---- a tiny classic-BPF interpreter, enough to run the filter on made-up syscalls ----
const RET_ALLOW = 0x7fff0000;
function runBpf(prog: Buffer, d: { arch: number; nr: number; arg0?: number }): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(d.nr, 0);
  data.writeUInt32LE(d.arch, 4);
  data.writeUInt32LE(d.arg0 ?? 0, 16);
  let a = 0;
  for (let pc = 0; pc < prog.length / 8; pc++) {
    const code = prog.readUInt16LE(pc * 8), jt = prog[pc * 8 + 2]!, jf = prog[pc * 8 + 3]!, k = prog.readUInt32LE(pc * 8 + 4);
    switch (code) {
      case 0x20: a = data.readUInt32LE(k); break;
      case 0x15: pc += a === k ? jt : jf; break;
      case 0x35: pc += a >= k ? jt : jf; break;
      case 0x45: pc += (a & k) !== 0 ? jt : jf; break;
      case 0x06: return k;
      default: throw new Error(`opcode ${code.toString(16)}`);
    }
  }
  throw new Error("fell off the program");
}
const X86 = 0xc000003e;
const ARM = 0xc00000b7;
const EPERM = 0x00050001;
const ENOSYS = 0x00050000 | 38;

describe("seccomp filter program", () => {
  test("x86_64: dangerous calls are refused, ordinary ones allowed", () => {
    const p = buildSeccompProgram("x86_64");
    expect(p.length % 8).toBe(0);
    const at = (nr: number, arg0?: number) => runBpf(p, { arch: X86, nr, arg0 });
    for (const [name, nr] of Object.entries({ mount: 165, umount2: 166, unshare: 272, setns: 308, pivot_root: 155, reboot: 169, bpf: 321, init_module: 175, kexec_load: 246, perf_event_open: 298, keyctl: 250 })) {
      expect([name, at(nr)]).toEqual([name, EPERM]);
    }
    for (const [name, nr] of Object.entries({ read: 0, write: 1, openat: 257, execve: 59, socket: 41, connect: 42, ptrace: 101, getpid: 39, mmap: 9 })) {
      expect([name, at(nr)]).toEqual([name, RET_ALLOW]);
    }
  });
  test("clone: plain flags pass, any CLONE_NEW* flag is refused; clone3 falls back via ENOSYS", () => {
    const p = buildSeccompProgram("x86_64");
    const CLONE_VM = 0x100, CLONE_THREAD = 0x10000, NEWUSER = 0x10000000, NEWNET = 0x40000000, NEWNS = 0x20000;
    expect(runBpf(p, { arch: X86, nr: 56, arg0: CLONE_VM | CLONE_THREAD | 0x11 })).toBe(RET_ALLOW);
    for (const f of [NEWUSER, NEWNET, NEWNS, CLONE_VM | NEWUSER]) expect(runBpf(p, { arch: X86, nr: 56, arg0: f })).toBe(EPERM);
    expect(runBpf(p, { arch: X86, nr: 435 })).toBe(ENOSYS);
  });
  test("another ABI and the x32 range are refused", () => {
    const p = buildSeccompProgram("x86_64");
    expect(runBpf(p, { arch: 0x40000003, nr: 3 })).toBe(EPERM); // 32-bit x86
    expect(runBpf(p, { arch: X86, nr: 0x40000000 | 1 })).toBe(EPERM); // x32
  });
  test("aarch64 numbers", () => {
    const p = buildSeccompProgram("aarch64");
    expect(runBpf(p, { arch: ARM, nr: 40 })).toBe(EPERM); // mount
    expect(runBpf(p, { arch: ARM, nr: 97 })).toBe(EPERM); // unshare
    expect(runBpf(p, { arch: ARM, nr: 63 })).toBe(RET_ALLOW); // read
    expect(runBpf(p, { arch: ARM, nr: 220, arg0: 0x10000000 })).toBe(EPERM); // clone NEWUSER
    expect(runBpf(p, { arch: X86, nr: 63 })).toBe(EPERM);
  });
  test("the list is documented by name and the file is written once", () => {
    expect(deniedSyscalls("x86_64")).toEqual(expect.arrayContaining(["mount", "unshare", "bpf", "clone(CLONE_NEW*)", "clone3"]));
    expect(deniedSyscalls("aarch64")).not.toContain("iopl");
    if (seccompArch()) {
      const f = seccompFile()!;
      expect(fs.readFileSync(f).equals(buildSeccompProgram(seccompArch()!))).toBe(true);
      expect(seccompFile()).toBe(f);
    }
  });
  test("org merge: the filter stays on unless every side turns it off", () => {
    expect(mergeSandboxOrg({ enabled: true, seccomp: true }, { seccomp: false }).seccomp).toBe(true);
    expect(mergeSandboxOrg({ enabled: true, seccomp: false }, { seccomp: true }).seccomp).toBe(true);
    expect(mergeSandboxOrg({ enabled: true, seccomp: false }, { seccomp: false }).seccomp).toBe(false);
    expect(mergeSandboxOrg({ enabled: true }, { enabled: true }).seccomp).toBeUndefined();
  });
});

describe("seccomp in the sandbox (bubblewrap)", () => {
  linuxTest("the filter is loaded by default and a command cannot make its own namespaces", async () => {
    if (!seccompArch()) return;
    const t = mk("sc");
    const on = setup(t, () => ({ enabled: true, mode: "per-command" }));
    expect(on.c.status(t.cwd).seccomp).toBe(true);
    expect(sandboxStatusLabel(on.c.status(t.cwd))).toContain("seccomp");
    const blocked = await exec.run({ command: "unshare -U true; echo rc=$?" }, on.ctx);
    expect(blocked.content).toMatch(/rc=1/);
    expect(blocked.content).toMatch(/not permitted/i);
    // ordinary work still runs
    const ok = await exec.run({ command: "echo fine && ls / > /dev/null && printf x | wc -c" }, on.ctx);
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain("fine");
  });
  linuxTest("seccomp: false turns it off", async () => {
    if (!seccompArch()) return;
    const t = mk("sc-off");
    const off = setup(t, () => ({ enabled: true, seccomp: false }));
    expect(off.c.status(t.cwd).seccomp).toBe(false);
    const r = await exec.run({ command: "unshare -U true; echo rc=$?" }, off.ctx);
    // Without the filter the call is up to the kernel: where this host allows user namespaces at all, it succeeds.
    const hostAllows = Bun.spawnSync(["unshare", "-U", "true"]).exitCode === 0;
    if (hostAllows) expect(r.content).toContain("rc=0");
    else expect(r.content).toContain("rc=");
    expect(sandboxStatusLabel(off.c.status(t.cwd))).not.toContain("seccomp");
  });
});

describe("whole-process mode", () => {
  const whole = (): SandboxSettings => ({ enabled: true, mode: "whole-process" });

  linuxTest("commands run in one long-lived sandbox: output, exit code and state shared between commands", async () => {
    const t = mk("wp");
    const { ctx, c } = setup(t, whole);
    const r = await exec.run({ command: "echo out; echo err >&2; exit 3" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit code: 3");
    expect(r.content).toMatch(/--- stdout ---\nout/);
    expect(r.content).toMatch(/--- stderr ---\nerr/);
    // The sandbox's private /tmp lives as long as the worker: a per-command sandbox would not see the file.
    await exec.run({ command: "echo shared > /tmp/marker" }, ctx);
    const again = await exec.run({ command: "cat /tmp/marker" }, ctx);
    expect(again.content).toContain("shared");
    const st = c.status(t.cwd);
    expect(st).toMatchObject({ mode: "whole-process", active: true });
    expect(st.policyHash).toMatch(/^[0-9a-f]{16}$/);
    expect(st.note).toBeUndefined();
    expect(sandboxStatusLabel(st)).toContain("whole-process");
    await c.dispose();
  });

  linuxTest("the policy still holds: writes outside the folder and credential reads are blocked and reported", async () => {
    const t = mk("wp-pol");
    const { ctx, c } = setup(t, whole);
    const inside = await exec.run({ command: "echo hi > inside.txt && cat inside.txt" }, ctx);
    expect(inside.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(t.cwd, "inside.txt"), "utf8")).toBe("hi\n");
    const bad = path.join(t.outside, "nope.txt");
    const w = await exec.run({ command: `echo x > ${bad}` }, ctx);
    expect(w.isError).toBe(true);
    expect(fs.existsSync(bad)).toBe(false);
    expect(w.content).toContain("Sandbox blocked: write to");
    const r = await exec.run({ command: `cat ${t.home}/.ssh/id_rsa` }, ctx);
    expect(r.content).not.toContain("FAKE-PRIVATE-KEY");
    expect(c.violations.list().some((v) => v.type === "filesystem-write" && v.target === bad)).toBe(true);
    await c.dispose();
  });

  linuxTest("a timeout kills the command inside the sandbox, not only the client", async () => {
    const t = mk("wp-kill");
    const { ctx, c } = setup(t, whole);
    const late = path.join(t.cwd, "late.txt");
    const r = await exec.run({ command: `sleep 2; echo done > ${late}`, timeoutMs: 400 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Timed out");
    await Bun.sleep(2600);
    expect(fs.existsSync(late)).toBe(false);
    await c.dispose();
  });

  linuxTest("a changed policy (session grant) starts a worker with a new hash; the old one stops when idle", async () => {
    const t = mk("wp-hash");
    const { ctx, c } = setup(t, whole, async () => ({ selectedOption: "proceed_once" }));
    await exec.run({ command: "echo one > /tmp/m" }, ctx);
    const first = c.status(t.cwd).policyHash;
    const bad = path.join(t.outside, "granted.txt");
    // The violation prompt answers "allow for this session": the grant changes the policy
    const denied = await exec.run({ command: `echo x > ${bad}` }, ctx);
    expect(denied.content).toContain("Allowed for this session");
    const ok = await exec.run({ command: `echo x > ${bad} && cat ${bad}` }, ctx);
    expect(ok.isError).toBeFalsy();
    const second = c.status(t.cwd).policyHash;
    expect(second).not.toBe(first);
    // new worker: its /tmp is new
    const gone = await exec.run({ command: "cat /tmp/m 2>&1; true" }, ctx);
    expect(gone.content).not.toContain("one");
    await c.dispose();
  });

  linuxTest("dispose stops the sandbox process", async () => {
    const t = mk("wp-dispose");
    const { ctx, c } = setup(t, whole);
    await exec.run({ command: "true" }, ctx);
    const pids = [...(c as any).workers.values()].map((e: any) => e.w.current.pid as number);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0]!, 0)).not.toThrow();
    await c.dispose();
    await Bun.sleep(100);
    expect(() => process.kill(pids[0]!, 0)).toThrow();
  });

  proxyTest("the network allow list works through one proxy bridge for the whole session", async () => {
    const t = mk("wp-net");
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const { ctx, c } = setup(t, () => ({ enabled: true, mode: "whole-process", network: { allowedDomains: ["localhost"] } }));
      const good = await exec.run({ command: `curl -s --max-time 5 http://localhost:${srv.port}/` }, ctx);
      expect(good.content).toContain("pong");
      const bad = await exec.run({ command: `curl -s --max-time 5 http://127.0.0.1:${srv.port}/` }, ctx);
      expect(bad.content).not.toContain("pong");
      expect(c.violations.list().at(-1)).toMatchObject({ type: "network", target: "127.0.0.1" });
      await c.dispose();
    } finally {
      srv.stop(true);
    }
  });

  test("policyHash is stable for the same policy and changes with any mount or network rule", () => {
    const base = { writable: ["/a", "/b"], readOnly: [], unreadable: [], readAllowed: [], network: { rule: "none" as const, allowedDomains: [], deniedDomains: [], allowLocalBinding: false }, orgRules: { denyRead: [], denyWrite: [], deniedDomains: [] } };
    const h = policyHash(base, "bubblewrap", true);
    expect(policyHash({ ...base, writable: ["/b", "/a"] }, "bubblewrap", true)).toBe(h);
    expect(policyHash({ ...base, writable: ["/a", "/b", "/c"] }, "bubblewrap", true)).not.toBe(h);
    expect(policyHash(base, "bubblewrap", false)).not.toBe(h);
    expect(policyHash({ ...base, network: { ...base.network, allowedDomains: ["x.com"] } }, "bubblewrap", true)).not.toBe(h);
  });
});
