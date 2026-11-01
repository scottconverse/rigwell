// The perf gate must fail on a first-keystroke regression or an oversized base prompt, and pass on good results.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_PROMPT_BUDGET } from "../../src/agent/budget.ts";
import { allowedKeystrokeP95, evaluate, type PerfBaseline, type PerfResults } from "../../perf/gate-lib.ts";
import { percentile } from "../../perf/stats.ts";
import { measureBasePrompt } from "../../perf/bench.ts";

const GATE = join(import.meta.dir, "../../perf/gate.ts");
const baseline: PerfBaseline = JSON.parse(readFileSync(join(import.meta.dir, "../../perf/baseline.json"), "utf8"));

const good = (): PerfResults => ({
  metrics: { firstKeystrokeP95Ms: baseline.firstKeystrokeP95Ms, firstKeystrokePtyP95Ms: 2, execFirstRequestMs: 100 },
  basePrompt: JSON.parse(JSON.stringify(baseline.basePrompt)),
});

describe("perf gate (pure)", () => {
  test("a result at baseline passes", () => {
    const ev = evaluate(good(), baseline);
    expect(ev.ok).toBe(true);
    expect(ev.markdown).toContain("perf gate: PASS");
  });

  test("a regressed first-keystroke p95 fails", () => {
    const r = good();
    r.metrics.firstKeystrokeP95Ms = allowedKeystrokeP95(baseline) + 5;
    const ev = evaluate(r, baseline);
    expect(ev.ok).toBe(false);
    expect(ev.checks.find((c) => c.name === "first-keystroke p95 vs baseline")!.ok).toBe(false);
    expect(ev.markdown).toContain("perf gate: FAIL");
  });

  test("a first-keystroke p95 over the spec cap fails even if the baseline were loose", () => {
    const loose = { ...baseline, firstKeystrokeP95Ms: 400 };
    const r = good();
    r.metrics.firstKeystrokeP95Ms = 300;
    const ev = evaluate(r, loose);
    expect(ev.ok).toBe(false);
    expect(ev.checks.find((c) => c.name === "first-keystroke p95 vs spec cap")!.ok).toBe(false);
  });

  test("a pty first-keystroke p95 over the cap fails", () => {
    const r = good();
    r.metrics.firstKeystrokePtyP95Ms = 251;
    expect(evaluate(r, baseline).ok).toBe(false);
  });

  test("a missing first-keystroke measurement fails (never passes silently)", () => {
    const r = good();
    delete r.metrics.firstKeystrokeP95Ms;
    expect(evaluate(r, baseline).ok).toBe(false);
  });

  test("an oversized base prompt fails, per part and mode", () => {
    for (const [mode, part] of [["direct_only", "systemChars"], ["direct_only", "toolsChars"], ["script_only", "systemChars"], ["script_only", "toolsChars"]] as const) {
      const r = good();
      r.basePrompt[mode][part] = BASE_PROMPT_BUDGET[mode][part] + 1;
      const ev = evaluate(r, baseline);
      expect(ev.ok).toBe(false);
      expect(ev.checks.find((c) => c.name === `base prompt ${mode} ${part}`)!.ok).toBe(false);
    }
    const r = good();
    r.basePrompt.contextChars = BASE_PROMPT_BUDGET.contextChars + 1;
    expect(evaluate(r, baseline).ok).toBe(false);
  });

  test("a prompt exactly at the budget passes", () => {
    const r = good();
    r.basePrompt.direct_only.toolsChars = BASE_PROMPT_BUDGET.direct_only.toolsChars;
    expect(evaluate(r, baseline).ok).toBe(true);
  });

  test("other metrics over target are reported but do not fail the gate", () => {
    const r = good();
    r.metrics.daemonReadyMs = 5000;
    const ev = evaluate(r, baseline);
    expect(ev.ok).toBe(true);
    expect(ev.markdown).toContain("over target");
  });
});

describe("perf gate (CLI exit code)", () => {
  const run = (results: PerfResults) => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-perf-"));
    const file = join(dir, "results.json");
    writeFileSync(file, JSON.stringify(results));
    return Bun.spawnSync(["bun", GATE, "--results", file], { stdout: "pipe", stderr: "pipe" });
  };

  test("exit 0 for good results", () => {
    const p = run(good());
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("PASS");
  });

  test("exit 1 for a synthetic first-keystroke regression", () => {
    const r = good();
    r.metrics.firstKeystrokeP95Ms = 120;
    const p = run(r);
    expect(p.exitCode).toBe(1);
    expect(p.stdout.toString()).toContain("FAIL");
  });

  test("exit 1 for a synthetic oversized base prompt", () => {
    const r = good();
    r.basePrompt.direct_only.systemChars += 5000;
    expect(run(r).exitCode).toBe(1);
  });
});

describe("perf measurement", () => {
  test("percentile uses nearest rank", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile([5], 95)).toBe(5);
  });

  test("the real base prompt stays within the budget and the recorded baseline is current", async () => {
    const got = await measureBasePrompt();
    const ev = evaluate({ metrics: { firstKeystrokeP95Ms: 0 }, basePrompt: got }, baseline);
    expect(ev.ok).toBe(true);
    expect(got.direct_only.toolsChars).toBeLessThanOrEqual(BASE_PROMPT_BUDGET.direct_only.toolsChars);
  });
});
