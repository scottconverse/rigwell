import type { EvalConfig, ExternalHarness, RunRecord, TaskDef, TrialResult } from "./types.ts";
import { runTrial } from "./runner.ts";
import { existsSync, statSync } from "node:fs";

/** Validate before starting either harness, so a missing mapping cannot produce a one-sided comparison. */
export function comparisonHarness(config: EvalConfig): ExternalHarness {
  const h = config.comparison;
  if (!h || typeof h.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(h.id)) throw new Error("comparison.id must be a simple nonempty identifier");
  if (!Array.isArray(h.command) || !h.command.length || h.command.some((v) => typeof v !== "string" || !v)) throw new Error("comparison.command must be an executable argument array");
  if (h.settingsPath !== undefined && (typeof h.settingsPath !== "string" || !h.settingsPath || !existsSync(h.settingsPath) || !statSync(h.settingsPath).isFile())) throw new Error("comparison.settingsPath must name an existing private settings file");
  if (typeof h.methodPrefix !== "string" || !/^[a-z][a-z0-9_.-]*\.$/i.test(h.methodPrefix)) throw new Error("comparison.methodPrefix must end with a dot");
  if (h.envelope !== undefined && (!h.envelope || typeof h.envelope !== "object" || Array.isArray(h.envelope))) throw new Error("comparison.envelope must be an object");
  if (h.versionArgs !== undefined && (!Array.isArray(h.versionArgs) || !h.versionArgs.length || h.versionArgs.some((v) => typeof v !== "string" || !v))) throw new Error("comparison.versionArgs must be a nonempty argument array");
  if (!config.models?.length || new Set(config.models.map((m) => m.id)).size !== config.models.length) throw new Error("Select distinct canonical models for both harnesses");
  for (const m of config.models) if (!h.modelMap || typeof h.modelMap[m.id] !== "string" || !h.modelMap[m.id].trim()) throw new Error("Missing external profile mapping for " + m.id);
  for (const m of config.models) if (!m.reasoningEffort || !["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(m.reasoningEffort)) throw new Error("Set explicit reasoningEffort for every comparison model");
  if (config.trials !== undefined && config.trials !== 3) throw new Error("Head-to-head comparisons require exactly three trials per harness");
  if (config.variants?.some((v) => v.toolExecutionMode || (v.settings && Object.keys(v.settings).length)) || (config.variants?.length ?? 0) > 1) throw new Error("Head-to-head compares the baseline harnesses; run tuning variants separately");
  if (config.autonomy && !["low", "medium", "high"].includes(config.autonomy)) throw new Error("Invalid comparison autonomy");
  return h;
}

async function observedVersion(harness: ExternalHarness, env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn([...harness.command, ...(harness.versionArgs ?? ["--version"])], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const version = stdout.trim().split(/\r?\n/)[0]?.slice(0, 200);
    if (code !== 0 || !version) throw new Error("Cannot verify external CLI version (exit " + code + "); no comparison trials started");
    return version;
  } finally { clearTimeout(timer); }
}

export interface ComparisonRuns { candidate: RunRecord; reference: RunRecord }

/** Same fixtures, graders, budgets, declared equivalent models and three independent trials on each side. */
export async function runComparison(opts: {
  config: EvalConfig; tasks: TaskDef[]; buildId: string; env?: Record<string, string>;
  onResult?: (side: "candidate" | "reference", result: TrialResult) => void;
}): Promise<ComparisonRuns> {
  const h = comparisonHarness(opts.config);
  if (!opts.tasks.length || new Set(opts.tasks.map((t) => t.name)).size !== opts.tasks.length) throw new Error("Select distinct shared tasks");
  const version = await observedVersion(h, opts.env), autonomy = opts.config.autonomy ?? "medium";
  const makeRun = (buildId: string, id: string, version: string): RunRecord => ({ schema: 1, buildId, startedAt: "", finishedAt: "", autonomy, trials: 3, results: [], harness: { id, version } });
  const reference = makeRun("reference-" + h.id + "-" + version, h.id, version);
  const candidate = makeRun(opts.buildId, "rigwell", opts.buildId);
  for (const model of opts.config.models) for (const task of opts.tasks) for (let trial = 1; trial <= 3; trial++) {
    // Alternate ordering within each pair without changing either side's trial inputs.
    const sides = trial % 2 ? ["reference", "candidate"] as const : ["candidate", "reference"] as const;
    for (const side of sides) {
      const run = side === "candidate" ? candidate : reference;
      if (!run.startedAt) run.startedAt = new Date().toISOString();
      const result = await runTrial({ task, model, variant: { name: "baseline" }, trial, autonomy, timeoutMs: opts.config.timeoutMs ?? 600000, env: opts.env, ...(side === "reference" ? { harness: h } : {}) });
      run.results.push(result); run.finishedAt = new Date().toISOString(); opts.onResult?.(side, result);
    }
  }
  return { candidate, reference };
}
