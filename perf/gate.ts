#!/usr/bin/env bun
// CI perf gate (spec section 7, Phase 7). Exits 1 when first-keystroke p95 regresses past the baseline tolerance or the
// spec cap, or when the base prompt grows past its budget. Prints a Markdown report (also appended to
// $GITHUB_STEP_SUMMARY when set).
//
//   bun perf/gate.ts                       run the benchmarks, then gate
//   bun perf/gate.ts --results r.json      gate saved results (no benchmarks)
//   bun perf/gate.ts --quick               fewer samples (local use)
//   bun perf/gate.ts --update-baseline     run the benchmarks and rewrite perf/baseline.json (review the diff!)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowedKeystrokeP95, evaluate, type PerfBaseline, type PerfResults } from "./gate-lib.ts";

const BASELINE_PATH = join(import.meta.dir, "baseline.json");
const a = process.argv.slice(2);
const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };

const baseline: PerfBaseline = JSON.parse(readFileSync(val("--baseline") ?? BASELINE_PATH, "utf8"));

async function measure(): Promise<PerfResults> {
  const { runBenchmarks } = await import("./bench.ts");
  return runBenchmarks({ quick: a.includes("--quick") });
}

if (a.includes("--update-baseline")) {
  const res = await measure();
  const next: PerfBaseline = { ...baseline, firstKeystrokeP95Ms: res.metrics.firstKeystrokeP95Ms ?? baseline.firstKeystrokeP95Ms, recorded: res.metrics, basePrompt: res.basePrompt };
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log(`wrote ${BASELINE_PATH}`);
  process.exit(0);
}

let results: PerfResults = val("--results") ? JSON.parse(readFileSync(val("--results")!, "utf8")) : await measure();
let ev = evaluate(results, baseline);

// Timing noise guard: a keystroke regression must show up twice in a row before it fails the build.
if (!val("--results") && results.metrics.firstKeystrokeP95Ms !== undefined && results.metrics.firstKeystrokeP95Ms > allowedKeystrokeP95(baseline)) {
  process.stderr.write("[perf] first-keystroke p95 over the limit; measuring again to rule out noise\n");
  const { benchKeystrokesInProcess } = await import("./bench.ts");
  const again = await benchKeystrokesInProcess(300);
  results = { ...results, metrics: { ...results.metrics, firstKeystrokeP95Ms: Math.min(results.metrics.firstKeystrokeP95Ms, Math.round(again.p95 * 100) / 100) } };
  ev = evaluate(results, baseline);
}

console.log(ev.markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ev.markdown);
process.exit(ev.ok ? 0 : 1);
