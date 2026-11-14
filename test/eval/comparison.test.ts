import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { comparisonHarness, runComparison } from "../../src/eval/comparison.ts";
import { loadTasks } from "../../src/eval/tasks.ts";
import { loadRuns } from "../../src/eval/store.ts";
import { CLI } from "../e2e/helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { EvalConfig } from "../../src/eval/types.ts";

const config = (): EvalConfig => ({ trials: 3, autonomy: "low", models: [{ id: "custom:Fixture-0", reasoningEffort: "low", prices: { inputPerMtok: 1, cachedInputPerMtok: 0.1, outputPerMtok: 2 } }], comparison: { id: "reference", command: [process.execPath, join(import.meta.dir, "../fakes/fake-comparison-cli.ts")], methodPrefix: "reference.", envelope: { apiVersion: "fixture-v1" }, modelMap: { "custom:Fixture-0": "external-fixture" } } });

test("head-to-head validation rejects incomplete mappings, unequal trial counts and tuning variants before spawning", () => {
  const missing = config(); missing.comparison!.modelMap = {};
  expect(() => comparisonHarness(missing)).toThrow("mapping");
  expect(() => comparisonHarness({ ...config(), trials: 2 })).toThrow("three trials");
  const noEffort = config(); delete noEffort.models[0]!.reasoningEffort;
  expect(() => comparisonHarness(noEffort)).toThrow("reasoningEffort");
  expect(() => comparisonHarness({ ...config(), variants: [{ name: "changed", settings: { extra: true } }] })).toThrow("baseline");
  const bad = config(); bad.comparison!.command = [];
  expect(() => comparisonHarness(bad)).toThrow("argument array");
});

test("the compare CLI runs three fresh trials per harness and stores observed version, metrics and the shared report", async () => {
  const env = tmpEnv(), audit = join(env.rigwellHome, "reference-audit.jsonl");
  const script = Array.from({ length: 3 }, () => [
    { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] },
    { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: '"Hello, "' } }] },
    { text: "Fixed the greeting." },
  ]).flat();
  const fake = await startFakeAnthropic(script);
  try {
    writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify({ customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "test-key-not-real" }] }));
    const settingsPath = join(env.rigwellHome, "reference-settings.json"); writeFileSync(settingsPath, "{}");
    const cfg = config(); cfg.comparison!.settingsPath = settingsPath;
    const configFile = join(env.rigwellHome, "comparison.json"); writeFileSync(configFile, JSON.stringify(cfg));
    const child = Bun.spawn([process.execPath, CLI, "eval", "compare", "--config", configFile, "--task", "fix-greeting-typo", "--build", "candidate-fixture", "--json"], { env: { ...process.env, RIGWELL_HOME: env.rigwellHome, FAKE_COMPARISON_AUDIT: audit, FAKE_COMPARISON_SETTINGS: settingsPath }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0); const result = JSON.parse(stdout);
    expect(result.reference.harness).toEqual({ id: "reference", version: "reference-fixture 1" });
    expect(result.candidate.harness).toEqual({ id: "rigwell", version: "candidate-fixture" });
    for (const run of [result.candidate, result.reference]) {
      expect(run.results).toHaveLength(3); expect(run.results.map((r: any) => r.trial)).toEqual([1, 2, 3]);
      expect(run.results.every((r: any) => r.passed && r.model === "custom:Fixture-0" && r.priced && r.reasoningEffort === "low")).toBe(true);
    }
    expect(result.reference.results.every((r: any) => r.requests === 1 && r.tokens.input === 100 && r.tokens.cacheRead === 25 && r.costUsd > 0 && r.wallMs > 0)).toBe(true);
    expect(result.report.groups[0].paired.tasks).toEqual(["fix-greeting-typo"]);
    expect(result.report.groups[0].stats.passRate).toBe(1);
    const rows = readFileSync(audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(new Set(rows.map((r) => r.cwd)).size).toBe(3); expect(rows.every((r) => r.autonomy === "low" && r.model === "external-fixture")).toBe(true);
    expect(fake.requests.length).toBe(9);
    expect(loadRuns().map((r) => r.harness?.id).sort()).toEqual(["reference", "rigwell"]);
  } finally { fake.stop(); env.cleanup(); }
}, 20000);

test("an unverifiable external CLI starts no trials and produces no candidate requests", async () => {
  const env = tmpEnv(), c = config(), audit = join(env.rigwellHome, "must-not-exist");
  c.comparison!.versionArgs = ["--invalid-version"];
  try {
    const error = await runComparison({ config: c, tasks: loadTasks(undefined, ["fix-greeting-typo"]), buildId: "candidate", env: { FAKE_COMPARISON_AUDIT: audit } }).then(() => null, (e) => e);
    expect(error.message).toContain("no comparison trials"); expect(existsSync(audit)).toBe(false);
  } finally { env.cleanup(); }
});
