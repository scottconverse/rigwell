// Phase 6 done-when: weekly report with per-model pass/cost/time vs the previous build.
// Two "builds" are run against scripted fake model servers; one model gains a pass, the other regresses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI } from "../e2e/helpers.ts";
import { runEval } from "../../src/eval/runner.ts";
import { loadRuns, saveRun } from "../../src/eval/store.ts";
import { loadTasks } from "../../src/eval/tasks.ts";
import { buildReport, renderMarkdown, selectRuns } from "../../src/eval/report.ts";
import type { EvalConfig } from "../../src/eval/types.ts";

const PRICES = { inputPerMtok: 1, cachedInputPerMtok: 0.1, outputPerMtok: 5 };
const home = mkdtempSync(join(tmpdir(), "rigwell-eval-home-"));
const savedHome = process.env.RIGWELL_HOME;
const servers: FakeServer[] = [];

beforeAll(() => { process.env.RIGWELL_HOME = home; });
afterAll(() => {
  servers.forEach((s) => s.stop());
  if (savedHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = savedHome;
});

const usage = (input: number) => ({ input, output: 200 });

/** Read, Edit, final text: three requests. */
function solve(file: string, oldText: string, newText: string, input: number): FakeTurn[] {
  return [
    { toolCalls: [{ name: "Read", input: { path: file } }], usage: usage(input) },
    { toolCalls: [{ name: "Edit", input: { path: file, old_text: oldText, new_text: newText } }], usage: usage(input) },
    { text: "Done.", usage: usage(input) },
  ];
}
const giveUp = (input: number): FakeTurn[] => [{ text: "I could not work this out.", usage: usage(input) }];
const clamp = (input: number) => solve("util.js", "return n * 2;\n}", "return n * 2;\n}\nexport function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}", input);
const greet = (input: number) => solve("greet.js", '"Helo, "', '"Hello, "', input);

async function writeSettings(urls: Record<string, string>) {
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    customModels: Object.entries(urls).map(([name, baseUrl]) => ({ model: "fake-anthropic", displayName: name, provider: "anthropic", baseUrl, apiKey: "test-key-not-real" })),
  }));
}

async function serve(script: FakeTurn[]) {
  const s = await startFakeAnthropic(script);
  servers.push(s);
  return s;
}

const config: EvalConfig = {
  autonomy: "low",
  trials: 1,
  models: [
    { id: "custom:Alpha-0", family: "alpha", prices: PRICES },
    { id: "custom:Beta-1", family: "beta", prices: PRICES },
  ],
};
const TASKS = ["add-clamp", "fix-greeting-typo"]; // run in this order

describe("eval loop: two builds, report with deltas", () => {
  test("task fixtures load and graders fail on the untouched fixture", () => {
    const tasks = loadTasks(undefined, TASKS.concat("rename-constant"));
    expect(tasks.map((t) => t.name)).toEqual(["add-clamp", "fix-greeting-typo", "rename-constant"]);
    for (const t of tasks) expect(t.prompt.length).toBeGreaterThan(10);
  });

  test("build one (via the rigwell eval run CLI), build two (in process), then the report", async () => {
    // Build aaa1111: Alpha fails add-clamp, passes greeting. Beta passes both.
    const a1 = await serve([...giveUp(1000), ...greet(1000)]);
    const b1 = await serve([...clamp(1000), ...greet(1000)]);
    await writeSettings({ Alpha: a1.url, Beta: b1.url });
    mkdirSync(join(home, "eval"), { recursive: true });
    writeFileSync(join(home, "eval", "config.json"), JSON.stringify(config));
    const proc = Bun.spawn(["bun", CLI, "eval", "run", "--build", "aaa1111", "--task", TASKS.join(",")], {
      env: { ...process.env, RIGWELL_HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    expect(err).toContain("aaa1111: 3/4 passed");
    expect(existsSync(out.trim())).toBe(true);
    expect(out.trim()).toContain(join(home, "eval", "runs", "aaa1111"));
    expect(a1.requests.length).toBe(4);
    expect(b1.requests.length).toBe(6);

    await Bun.sleep(5);
    // Build bbb2222: Alpha passes both; Beta passes add-clamp at double the token cost and fails the greeting.
    const a2 = await serve([...clamp(1000), ...greet(1000)]);
    const b2 = await serve([...clamp(4000), ...giveUp(4000)]);
    await writeSettings({ Alpha: a2.url, Beta: b2.url });
    const run2 = await runEval({ config, tasks: loadTasks(undefined, TASKS), buildId: "bbb2222" });
    saveRun(run2);
    expect(readdirSync(join(home, "eval", "runs")).sort()).toEqual(["aaa1111", "bbb2222"]);

    const runs = loadRuns();
    expect(runs.map((r) => r.buildId)).toEqual(["aaa1111", "bbb2222"]);
    const { current, previous } = selectRuns(runs, { sinceMs: 7 * 86_400_000 });
    expect(current!.buildId).toBe("bbb2222");
    expect(previous!.buildId).toBe("aaa1111");
    const rep = buildReport(current!, previous);

    const alpha = rep.groups.find((g) => g.model === "custom:Alpha-0")!;
    const beta = rep.groups.find((g) => g.model === "custom:Beta-1")!;

    // Alpha: 1/2 -> 2/2. Requests 1+3 = 4 over 2 trials before, 6 now. $0.002 per request.
    expect(alpha.prev!.passRate).toBe(0.5);
    expect(alpha.stats.passRate).toBe(1);
    expect(alpha.deltas!.passRatePp).toBeCloseTo(50, 5);
    expect(alpha.prev!.meanRequests).toBe(2);
    expect(alpha.stats.meanRequests).toBe(3);
    expect(alpha.prev!.meanCostUsd).toBeCloseTo(0.004, 8);
    expect(alpha.stats.meanCostUsd).toBeCloseTo(0.006, 8);
    expect(alpha.deltas!.meanCostPct).toBeCloseTo(0.5, 5);
    expect(alpha.prev!.costPerPassUsd).toBeCloseTo(0.008, 8); // one pass, $0.008 spent in total
    expect(alpha.stats.costPerPassUsd).toBeCloseTo(0.006, 8);
    // Only the greeting task passed in both builds, so the fair comparison is that one task: $0.006 both times.
    expect(alpha.paired!.tasks).toEqual(["fix-greeting-typo"]);
    expect(alpha.paired!.costPct).toBeCloseTo(0, 8);

    // Beta: 2/2 -> 1/2, flagged. add-clamp now costs more per request.
    expect(beta.prev!.passRate).toBe(1);
    expect(beta.stats.passRate).toBe(0.5);
    expect(beta.deltas!.passRatePp).toBeCloseTo(-50, 5);
    expect(beta.prev!.meanCostUsd).toBeCloseTo(0.006, 8);
    expect(beta.stats.meanCostUsd).toBeCloseTo(0.01, 8);
    expect(beta.paired!.tasks).toEqual(["add-clamp"]);
    expect(beta.paired!.cur.meanCostUsd).toBeCloseTo(0.015, 8);
    expect(beta.paired!.prev.meanCostUsd).toBeCloseTo(0.006, 8);
    expect(beta.paired!.costPct).toBeCloseTo(1.5, 5);

    const alphaTask = rep.tasks.find((t) => t.model === "custom:Alpha-0" && t.task === "add-clamp")!;
    expect(alphaTask.prevPassRate).toBe(0);
    expect(alphaTask.passRate).toBe(1);

    expect(rep.regressions.some((r) => r.includes("custom:Beta-1") && r.includes("pass rate 100% -> 50%"))).toBe(true);
    expect(rep.regressions.some((r) => r.includes("fix-greeting-typo on custom:Beta-1") && r.includes("was 100%, now 0%"))).toBe(true);
    expect(rep.regressions.some((r) => r.includes("custom:Beta-1") && r.includes("mean cost up 150%"))).toBe(true);
    expect(rep.regressions.some((r) => r.includes("custom:Alpha-0") && !r.includes("mean time"))).toBe(false); // wall time is noisy
    expect(rep.improvements.some((r) => r.includes("custom:Alpha-0"))).toBe(true);

    // Every trial's request count matches what the fake servers actually received.
    expect(run2.results.filter((r) => r.model === "custom:Alpha-0").map((r) => r.requests)).toEqual([3, 3]);
    expect(run2.results.filter((r) => r.model === "custom:Beta-1").map((r) => r.requests)).toEqual([3, 1]);
    expect(a2.requests.length + b2.requests.length).toBe(10);
    expect(run2.results.every((r) => r.wallMs > 0 && r.turnReason === "completed")).toBe(true);

    const md = renderMarkdown(rep);
    expect(md).toContain("Build `bbb2222`");
    expect(md).toContain("previous build `aaa1111`");
    expect(md).toContain("REGRESSION custom:Beta-1");
    expect(md).toContain("+50pp");
    expect(md).toContain("-50pp");
    expect(md.includes(String.fromCharCode(0x2014))).toBe(false);

    // The CLI report in JSON mode agrees.
    const cli = Bun.spawn(["bun", CLI, "eval", "report", "--since", "7d", "--json"], { env: { ...process.env, RIGWELL_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const json = JSON.parse(await new Response(cli.stdout).text());
    expect(await cli.exited).toBe(0);
    expect(json.current.buildId).toBe("bbb2222");
    expect(json.previous.buildId).toBe("aaa1111");
    expect(json.groups.find((g: any) => g.model === "custom:Beta-1").deltas.passRatePp).toBeCloseTo(-50, 5);

    // --since with nothing in the window fails clearly.
    const old = selectRuns(runs, { sinceMs: 1000, now: Date.now() + 10 * 86_400_000 });
    expect(old.current).toBeUndefined();
  }, 120_000);
});
