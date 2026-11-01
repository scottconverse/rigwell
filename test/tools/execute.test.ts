import { describe, expect, test } from "bun:test";
import type { ToolProgress } from "../../src/core/types.ts";
import { createExecuteTool } from "../../src/tools/execute.ts";
import { makeCtx, tmpDir } from "./helpers.ts";

const exec = createExecuteTool();

describe("Execute", () => {
  test("success runs in cwd, streams progress", async () => {
    const d = tmpDir();
    const prog: ToolProgress[] = [];
    const r = await exec.run({ command: "pwd; echo err >&2" }, makeCtx(d, { onProgress: (p) => prog.push(p) }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("exit code: 0");
    expect(r.content).toContain(d);
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
