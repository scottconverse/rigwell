import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, parseSince, renderMarkdown, selectRuns } from "../../src/eval/report.ts";
import { costOf, cacheHitRate } from "../../src/eval/cost.ts";
import { runTrial } from "../../src/eval/runner.ts";
import { defaultTasksDir, loadTask } from "../../src/eval/tasks.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { RunRecord, TrialResult } from "../../src/eval/types.ts";

function tr(over: Partial<TrialResult>): TrialResult {
  return {
    task: "t1", model: "m1", family: "fam1", variant: "baseline", trial: 1, passed: true, failKind: "none", graderDetail: "PASS",
    turnReason: "completed", wallMs: 1000, requests: 2, tokens: { input: 1000, cacheRead: 0, cacheCreation: 0, output: 100 },
    costUsd: 0.01, priced: true, cacheHitRate: 0, ...over,
  };
}
const run = (buildId: string, startedAt: string, results: TrialResult[]): RunRecord =>
  ({ schema: 1, buildId, startedAt, finishedAt: startedAt, autonomy: "low", trials: 1, results });

describe("cost and cache math", () => {
  test("price table in $/Mtok", () => {
    const t = { input: 1_000_000, cacheRead: 2_000_000, cacheCreation: 500_000, output: 100_000 };
    const p = { inputPerMtok: 3, cachedInputPerMtok: 0.3, outputPerMtok: 15 };
    expect(costOf(t, p)).toBeCloseTo(3 + 0.6 + 1.5 + 1.5, 10); // cache writes default to the input price
    expect(costOf(t, { ...p, cacheWritePerMtok: 4 })).toBeCloseTo(3 + 0.6 + 2 + 1.5, 10);
    expect(costOf(t, undefined)).toBe(0);
    expect(cacheHitRate(t)).toBeCloseTo(2 / 3.5, 10);
  });
});

describe("selection", () => {
  const runs = [
    run("a", "2026-10-01T00:00:00.000Z", [tr({})]),
    run("b", "2026-10-20T00:00:00.000Z", [tr({})]),
    run("b", "2026-10-21T00:00:00.000Z", [tr({})]),
    run("c", "2026-10-28T00:00:00.000Z", [tr({})]),
  ];
  test("latest run vs the latest run of the previous different build", () => {
    const s = selectRuns(runs);
    expect(s.current!.buildId).toBe("c");
    expect(s.previous!.buildId).toBe("b");
    expect(s.previous!.startedAt).toBe("2026-10-21T00:00:00.000Z");
  });
  test("--since window, --build and --against", () => {
    const now = Date.parse("2026-10-29T00:00:00.000Z");
    expect(selectRuns(runs, { sinceMs: parseSince("7d"), now }).current!.buildId).toBe("c");
    expect(selectRuns(runs, { sinceMs: parseSince("1h"), now }).current).toBeUndefined();
    expect(selectRuns(runs, { build: "b" }).previous!.buildId).toBe("a");
    expect(selectRuns(runs, { against: "a" }).previous!.buildId).toBe("a");
    expect(parseSince("12h")).toBe(12 * 3_600_000);
    expect(() => parseSince("soon")).toThrow();
  });
});

describe("report content", () => {
  test("failure clusters need repeats across tasks and models", () => {
    const fail = (task: string, model: string, detail: string) => tr({ task, model, passed: false, failKind: "grader", graderDetail: detail });
    const r = buildReport(run("x", "2026-10-01T00:00:00.000Z", [
      fail("t1", "m1", "FAIL clamp(5,0,10) gave 7"), fail("t2", "m2", "FAIL clamp(9,0,10) gave 3"),
      fail("t3", "m1", "FAIL something unique"),
    ]));
    expect(r.clusters.length).toBe(1);
    expect(r.clusters[0]!.tasks).toEqual(["t1", "t2"]);
    expect(r.clusters[0]!.models).toEqual(["m1", "m2"]);
  });

  test("unpriced models do not get cost deltas or cost flags", () => {
    const prev = run("a", "2026-10-01T00:00:00.000Z", [tr({ priced: false, costUsd: 0 })]);
    const cur = run("b", "2026-10-02T00:00:00.000Z", [tr({ priced: false, costUsd: 0 })]);
    const rep = buildReport(cur, prev);
    expect(rep.groups[0]!.deltas!.meanCostPct).toBeNull();
    expect(renderMarkdown(rep)).toContain("unpriced");
    expect(rep.regressions).toEqual([]);
  });

  test("time regressions are flagged beyond the threshold", () => {
    const prev = run("a", "2026-10-01T00:00:00.000Z", [tr({ wallMs: 1000 })]);
    const cur = run("b", "2026-10-02T00:00:00.000Z", [tr({ wallMs: 2000 })]);
    const rep = buildReport(cur, prev);
    expect(rep.regressions.some((x) => x.includes("mean time up 100%"))).toBe(true);
  });

  test("variant experiment: ship only if it holds on every family, else per-model option", () => {
    const base = (model: string, family: string, passed: boolean, cost = 0.01) => tr({ model, family, variant: "baseline", passed, costUsd: cost });
    const cand = (model: string, family: string, passed: boolean, cost = 0.01) => tr({ model, family, variant: "tighter-edit-desc", passed, costUsd: cost });
    const allBetter = buildReport(run("x", "2026-10-01T00:00:00.000Z", [
      base("m1", "f1", false), cand("m1", "f1", true), base("m2", "f2", true, 0.02), cand("m2", "f2", true, 0.01),
    ]));
    expect(allBetter.experiments[0]!.decision).toBe("ship");
    expect(allBetter.experiments[0]!.models.map((m) => m.outcome)).toEqual(["better", "better"]);
    const mixed = buildReport(run("x", "2026-10-01T00:00:00.000Z", [
      base("m1", "f1", false), cand("m1", "f1", true), base("m2", "f2", true), cand("m2", "f2", false),
    ]));
    expect(mixed.experiments[0]!.decision).toBe("per-model option");
    expect(mixed.experiments[0]!.note).toContain("worse on f2");
    const worse = buildReport(run("x", "2026-10-01T00:00:00.000Z", [base("m1", "f1", true), cand("m1", "f1", false)]));
    expect(worse.experiments[0]!.decision).toBe("do not ship");
    expect(renderMarkdown(mixed)).toContain("Human review decides");
  });
});

describe("runner budgets", () => {
  const servers: { stop(): void }[] = [];
  afterAll(() => servers.forEach((s) => s.stop()));

  test("a task over its request budget fails with failKind budget even if the grader would pass", async () => {
    const tasks = mkdtempSync(join(tmpdir(), "rigwell-eval-tasks-"));
    cpSync(join(defaultTasksDir(), "fix-greeting-typo"), join(tasks, "tight"), { recursive: true });
    writeFileSync(join(tasks, "tight", "task.json"), JSON.stringify({ grader: 'node "$EVAL_TASK_DIR/grade.cjs"', budget: { maxRequests: 2, timeoutMs: 30000 } }));
    const task = loadTask(join(tasks, "tight"));
    const server = await startFakeAnthropic([
      { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] },
      { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: '"Hello, "' } }] },
      { text: "Done." },
    ]);
    servers.push(server);
    const home = mkdtempSync(join(tmpdir(), "rigwell-eval-home2-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ customModels: [{ model: "f", displayName: "Gamma", provider: "anthropic", baseUrl: server.url, apiKey: "test-key-not-real" }] }));
    const r = await runTrial({ task, model: { id: "custom:Gamma-0" }, variant: { name: "baseline" }, trial: 1, autonomy: "low", timeoutMs: 30000, env: { RIGWELL_HOME: home } });
    expect(r.requests).toBe(3);
    expect(r.passed).toBe(false);
    expect(r.failKind).toBe("budget");
  }, 60_000);
});
