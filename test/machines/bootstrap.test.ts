import { expect, test } from "bun:test";
import { bootstrapMachine, probeRemote } from "../../src/machines/bootstrap.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { startRemoteBuild } from "../../src/machines/remote-start.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { join } from "node:path";

test("bootstrap copies the exact build and records it only after remote verification", async () => {
  const env = tmpEnv(), build = "a".repeat(64), bytes = new Uint8Array([1, 2]);
  const calls: { command: string; input?: Uint8Array }[] = [];
  const store = new MachineStore(); store.save({ name: "remote", host: "owner@fixture" });
  try {
    const machine = await bootstrapMachine("remote", { store,
      bundle: async () => ({ build, version: "0.1.0", bytes }),
      run: async (_m, command, opts) => {
        calls.push({ command, input: opts?.input });
        if (calls.length === 1) return { code: 0, stdout: "Linux\nx86_64\n/home/fixture\n", stderr: "" };
        if (calls.length === 4) return { code: 0, stdout: JSON.stringify({ build, version: "0.1.0" }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(machine.root).toBe("/home/fixture/.rigwell/remote/aaaaaaaaaaaaaaaa");
    expect(store.get("remote").build).toBe(build); expect(calls.length).toBe(5);
    expect(calls[1]!.input).toBe(bytes); expect(calls[3]!.command).toContain(build);
    expect(calls[3]!.command).toContain("incoming-"); expect(calls[4]!.command).toContain("Unsafe staging cleanup");
  } finally { env.cleanup(); }
});

test("bootstrap rejects a daemon mismatch without recording a false successful install", async () => {
  const env = tmpEnv(), store = new MachineStore(); let calls = 0;
  store.save({ name: "remote", host: "fixture" });
  try {
    let error: any;
    try { await bootstrapMachine("remote", { store, bundle: async () => ({ build: "a".repeat(64), version: "0.1.0", bytes: new Uint8Array() }), run: async () => ({ code: 0, stdout: ++calls === 1 ? "Darwin\narm64\n/Users/fixture\n" : calls === 4 ? '{"build":"wrong","version":"0.1.0"}' : "", stderr: "" }) }); } catch (e) { error = e; }
    expect(error?.message).toContain("does not match"); expect(store.get("remote").build).toBeUndefined();
  } finally { env.cleanup(); }
});

test("Windows probing uses noninteractive encoded commands and rejects SSH authentication failure", async () => {
  let calls = 0;
  const info = await probeRemote({ name: "fixture", host: "owner@fixture" }, async (_m, command) => {
    if (++calls === 1) return { code: 1, stdout: "", stderr: "uname unavailable" };
    expect(command).toContain("-NonInteractive -EncodedCommand");
    return { code: 0, stdout: "win32\nX64\nC:\\Users\\fixture\n", stderr: "" };
  });
  expect(info).toEqual({ platform: "win32", arch: "x64", home: "C:\\Users\\fixture" });
  let error: any;
  try { await probeRemote({ name: "fixture", host: "fixture" }, async () => ({ code: 255, stdout: "", stderr: "Host key verification failed" })); } catch (e) { error = e; }
  expect(error?.message).toContain("Host key verification failed");
});

test("remote launch refuses a changed manifest before executing the installed runtime", async () => {
  const env = tmpEnv();
  try {
    writeJson(join(env.root, "remote-build.json"), { build: "b".repeat(64) });
    let error: any;
    try { await startRemoteBuild(env.root, "a".repeat(64)); } catch (e) { error = e; }
    expect(error?.message).toContain("not the requested build");
  } finally { env.cleanup(); }
});
