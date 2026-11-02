// Script sandbox: behavior, limits, and escape attempts (every escape must fail closed).
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScript } from "../../src/script/parse.ts";
import { ResultLog } from "../../src/script/resultlog.ts";
import { ScriptRun } from "../../src/script/run.ts";
import { ToolCallError } from "../../src/script/bindings.ts";

beforeAll(() => { process.env.RIGWELL_HOME = mkdtempSync(join(tmpdir(), "rigwell-script-home-")); });

let seq = 0;
async function run(code: string, limits: Record<string, number> = {}, callTool?: (name: string, input: any) => Promise<any>) {
  const parsed = parseScript(code);
  if ("error" in parsed) throw new Error(parsed.error);
  const sessionId = `s-${++seq}`;
  const r = new ScriptRun({
    jobId: `scr_${seq}`, runId: `run-${seq}`, outerId: `outer-${seq}`, sessionId, parsed,
    toolNames: ["Read", "Edit", "Grep"], resultLog: new ResultLog(sessionId), limits,
    host: {
      cwd: "/tmp",
      notify: () => {},
      callTool: async (name, input) => {
        if (callTool) return callTool(name, input);
        return { content: JSON.stringify({ ok: name }) };
      },
    },
  });
  r.start();
  await r.done;
  return r.report() as { status: string; output: string; tool_calls: number; errors: any[] };
}

describe("parseScript", () => {
  test("control line, input blocks, code, line numbers kept", () => {
    const p = parseScript("//@background\n//@input old <<END\na\n  b\nEND\n//@input new <<X\nz\nX\nprint(inputs.old)\n");
    if ("error" in p) throw new Error(p.error);
    expect(p.background).toBe(true);
    expect(p.inputs).toEqual({ old: "a\n  b", new: "z" });
    expect(p.code.split("\n").length).toBe(10);
    expect(p.code.trim()).toBe("print(inputs.old)");
  });
  test("unterminated block and oversized blocks are errors", () => {
    expect("error" in (parseScript("//@input a <<END\nnever closed") as any)).toBe(true);
    const big = "x".repeat(1024 * 1024 + 1);
    expect("error" in (parseScript(`//@input a <<END\n${big}\nEND\n1`) as any)).toBe(true);
  });
  test("//@background only counts on the first line", () => {
    const p = parseScript("print(1)\n//@background") as any;
    expect(p.background).toBe(false);
  });
});

describe("Script behavior", () => {
  test("tools, inputs, print, concurrency, async module", async () => {
    const r = await run("//@input t <<E\nhello\nE\nconst rs = await Promise.all([1,2,3].map(i => tools.Edit({ path: 'f' + i })));\nprint(inputs.t, rs.length, rs[0].ok);", {});
    expect(r.status).toBe("completed");
    expect(r.output).toBe("hello 3 Edit\n");
    expect(r.tool_calls).toBe(3);
  });
  test("a failed call rejects with its message; an uncaught error is reported with prior output", async () => {
    const r = await run("print('before'); await tools.Edit({}); print('after');", {}, async () => { throw new ToolCallError("nope", "PermissionDenied"); });
    expect(r.status).toBe("failed");
    expect(r.output).toContain("before");
    expect(r.output).toContain("PermissionDenied: nope");
    expect(r.output).not.toContain("after");
    expect(r.errors[0]).toMatchObject({ call: 1, tool: "Edit", message: "nope" });
  });
  test("printed text keeps head and tail over 64 KiB", async () => {
    const r = await run("for (let i = 0; i < 200; i++) print('line' + i + ' ' + 'x'.repeat(1000));");
    expect(r.output.length).toBeLessThan(70_000);
    expect(r.output).toContain("line0 ");
    expect(r.output).toContain("line199 ");
    expect(r.output).toContain("characters cut");
  });
  test("the runner does not exit by itself after done, so no output can be lost to an exit race", async () => {
    const { RUNNER_PATH } = await import("../../src/script/sandbox.ts");
    const proc = Bun.spawn([process.execPath, RUNNER_PATH], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    (proc.stdin as any).write(JSON.stringify({
      type: "run", code: "for (let i = 0; i < 300; i++) print('l' + i + ' ' + 'x'.repeat(2000));", inputs: {}, toolNames: [],
      memoryBytes: 64 * 1024 * 1024, stackBytes: 1024 * 1024, sliceMs: 10_000,
    }) + "\n");
    (proc.stdin as any).flush?.();
    let exited = false;
    void proc.exited.then(() => { exited = true; });
    // Deliberately slow reader: the pipe stays full while the child finishes.
    const dec = new TextDecoder();
    let buf = "", prints = 0, done = false;
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      await new Promise((r) => setTimeout(r, 5));
      buf += dec.decode(chunk, { stream: true });
      for (const line of buf.split("\n").slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.type === "print") prints++;
        if (m.type === "done") done = true;
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(exited).toBe(false);
    proc.kill("SIGKILL");
    expect(done).toBe(true);
    expect(prints).toBe(300);
  });
  test("event cap of 1,024", async () => {
    const r = await run("for (let i = 0; i < 1500; i++) print(i);");
    expect(r.output).toContain("events were dropped");
    expect(r.output).toContain("1023");
    expect(r.output).not.toContain("\n1030\n");
  });
  test("a result over 5 MiB is rejected", async () => {
    const r = await run("try { await tools.Read({}); } catch (e) { print('rejected', e.message.slice(0, 20)); }", {},
      async () => ({ content: "x".repeat(5 * 1024 * 1024 + 1) }));
    expect(r.output).toContain("rejected");
  });
  test("results.search and results.get", async () => {
    const r = await run("await tools.Grep({ pattern: 'needle' }); const h = await results.search('needle'); print(h.length, h[0].tool); print(JSON.stringify(await results.get(h[0].job_id, h[0].call)));", {},
      async () => ({ content: JSON.stringify({ files: ["a.txt"], note: "needle here" }) }));
    expect(r.output).toContain("1 Grep");
    expect(r.output).toContain("needle here");
  });
  test("at most 128 calls in flight", async () => {
    let live = 0, peak = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const r = await run("await Promise.all(Array.from({ length: 300 }, (_, i) => tools.Read({ i })));", {}, async () => {
      live++; peak = Math.max(peak, live);
      // Hold every call until the cap is reached, so the peak does not depend on how fast the pipe delivers calls.
      if (live >= 128) releaseGate();
      await Promise.race([gate, Bun.sleep(5000)]);
      live--;
      return { content: "{}" };
    });
    expect(r.status).toBe("completed");
    expect(r.tool_calls).toBe(300);
    expect(peak).toBeLessThanOrEqual(128);
    expect(peak).toBe(128);
  });
});

describe("sandbox escapes fail closed", () => {
  const probe = async (code: string, limits: Record<string, number> = {}) => run(code, limits);

  test("no host globals", async () => {
    const r = await probe("print([typeof process, typeof require, typeof fetch, typeof Bun, typeof setTimeout, typeof setInterval, typeof module, typeof globalThis.process, typeof WebAssembly, typeof XMLHttpRequest].join(','));");
    expect(r.output.trim()).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
  });
  for (const [name, code] of [
    ["constructor chain", 'this.constructor.constructor("return process")()'],
    ["Function constructor", 'new Function("return process.env")()'],
    ["async function constructor", 'await (async()=>{}).constructor("return require(\'fs\')")()'],
    ["eval", 'eval("process.exit(1)")'],
    ["dynamic import of fs", 'await import("fs")'],
    ["dynamic import of node:fs", 'await import("node:fs")'],
    ["dynamic import of a data url", 'await import("data:text/javascript,export default 1")'],
    ["require", 'require("fs").readFileSync("/etc/passwd")'],
    ["globalThis.process", 'globalThis.process.env'],
    ["Bun", 'Bun.file("/etc/passwd").text()'],
    ["fetch", 'await fetch("http://127.0.0.1:1/")'],
    ["read file without tools", 'std.loadFile("/etc/passwd")'],
    ["os module", 'os.getcwd()'],
    ["host function recovery", 'print(typeof call, typeof __call, typeof globalThis.call)'],
  ] as const) {
    test(name, async () => {
      const r = await probe(code);
      if (name === "host function recovery") {
        expect(r.output.trim()).toBe("undefined undefined undefined");
        return;
      }
      expect(r.status).toBe("failed");
      expect(r.output).toContain("Script error");
      expect(r.output).not.toContain("root:");
    });
  }

  test("prototype pollution stays inside the guest", async () => {
    const before = ({} as any).polluted;
    const r = await probe("Object.prototype.polluted = 'yes'; Array.prototype.x = 1; print(({}).polluted);");
    expect(r.status).toBe("completed");
    expect(({} as any).polluted).toBe(before);
    expect(([] as any).x).toBeUndefined();
  });

  test("tools object cannot be tampered with to add a name", async () => {
    const r = await probe("'use strict'; try { tools.Evil = () => 1; print('added'); } catch (e) { print('blocked'); }");
    expect(r.output.trim()).toBe("blocked");
  });

  test("infinite loop is killed at the time limit", async () => {
    const t = Date.now();
    const r = await probe("while (true) {}", { sliceMs: 300 });
    expect(r.status).toBe("failed");
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.output).toContain("interrupted");
  });

  test("a program that never finishes is stopped at the total time limit", async () => {
    const t = Date.now();
    const r = await run("await tools.Read({});", { totalMs: 400 }, () => new Promise(() => {}));
    expect(r.status).toBe("timed_out");
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  test("memory blow-up fails", async () => {
    const r = await probe("let s = 'x'; for (;;) s += s;", { memoryBytes: 32 * 1024 * 1024 });
    expect(r.status).toBe("failed");
    expect(r.output.toLowerCase()).toMatch(/out of memory|invalid string length/);
  }, 30000);

  test("runaway recursion fails", async () => {
    const r = await probe("const f = () => f(); f();");
    expect(r.status).toBe("failed");
  });

  test("a promise that can never resolve ends the Script with an error", async () => {
    const r = await probe("await new Promise(() => {});");
    expect(r.status).toBe("failed");
    expect(r.output).toContain("can never resolve");
  });
});
