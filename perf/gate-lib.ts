// Gate logic (pure): compares benchmark results with the baseline and the budgets, renders Markdown.
// Gated: first-keystroke p95 (hard cap = spec target, plus regression vs baseline) and base-prompt size (budget).
// Everything else in spec section 7 is reported against its target but not gated (too machine dependent).
import { BASE_PROMPT_BUDGET } from "../src/agent/budget.ts";

export type MetricKey =
  | "firstKeystrokeP95Ms" | "firstKeystrokeP50Ms" | "firstKeystrokePtyP95Ms"
  | "turnPrepColdMs" | "turnPrepWarmP95Ms" | "preflightToolLookupMs" | "execFirstRequestMs"
  | "daemonReadyMs" | "perSessionMemoryMb" | "quitMs" | "firstPaintMs" | "firstPromptAcceptedMs";

export interface PerfResults {
  /** Milliseconds unless the key says otherwise. Missing keys mean "not measured on this machine". */
  metrics: Partial<Record<MetricKey, number>>;
  /** Base prompt sizes in characters, per tool execution mode. */
  basePrompt: Record<"direct_only" | "script_only", { systemChars: number; toolsChars: number }> & { contextChars: number };
  /** How the numbers were taken (sample counts etc.), shown in the report. */
  notes?: string[];
}

export interface PerfBaseline {
  /** Recorded in-process first-keystroke p95 (ms) and the regression tolerance. */
  firstKeystrokeP95Ms: number;
  tolerance: { factor: number; slackMs: number };
  /** Spec section 7 hard cap for first-keystroke p95. */
  firstKeystrokeCapMs: number;
  /** Recorded values for the other metrics, for the report only. */
  recorded: Partial<Record<MetricKey, number>>;
  basePrompt: PerfResults["basePrompt"];
}

/** Spec section 7 targets: every metric should stay at or under the target. */
export const TARGETS: Record<MetricKey, { label: string; target: number; unit: string; spec: string }> = {
  firstKeystrokeP95Ms: { label: "First-keystroke p95 (in-process TUI)", target: 250, unit: "ms", spec: "<= 250 ms, enforced in CI" },
  firstKeystrokeP50Ms: { label: "First-keystroke p50 (in-process TUI)", target: 250, unit: "ms", spec: "no target (info)" },
  firstKeystrokePtyP95Ms: { label: "First-keystroke p95 (pty, whole process)", target: 250, unit: "ms", spec: "<= 250 ms" },
  turnPrepColdMs: { label: "Turn preparation, first turn (Enter to request sent)", target: 125, unit: "ms", spec: "<= 125 ms" },
  turnPrepWarmP95Ms: { label: "Turn preparation, later turns p95", target: 125, unit: "ms", spec: "<= 125 ms" },
  preflightToolLookupMs: { label: "Pre-flight tool lookup", target: 1, unit: "ms", spec: "~1 ms" },
  execFirstRequestMs: { label: "exec: process start to first model request", target: 700, unit: "ms", spec: "< 700 ms" },
  daemonReadyMs: { label: "Daemon launch to ready", target: 400, unit: "ms", spec: "< 400 ms" },
  perSessionMemoryMb: { label: "Memory per extra session", target: 20, unit: "MB", spec: "~20 MB" },
  quitMs: { label: "Quit (/quit typed to process exit)", target: 30, unit: "ms", spec: "~30 ms" },
  firstPaintMs: { label: "TUI first paint (process start)", target: 500, unit: "ms", spec: "< 500 ms" },
  firstPromptAcceptedMs: { label: "TUI first prompt accepted (process start)", target: 650, unit: "ms", spec: "< 650 ms" },
};

export interface Check { name: string; ok: boolean; gated: boolean; detail: string }
export interface Evaluation { ok: boolean; checks: Check[]; markdown: string }

export const allowedKeystrokeP95 = (b: PerfBaseline) =>
  Math.min(b.firstKeystrokeCapMs, Math.max(b.firstKeystrokeP95Ms * b.tolerance.factor, b.firstKeystrokeP95Ms + b.tolerance.slackMs));

export function evaluate(res: PerfResults, base: PerfBaseline, budget: typeof BASE_PROMPT_BUDGET = BASE_PROMPT_BUDGET): Evaluation {
  const checks: Check[] = [];
  const m = res.metrics;

  const p95 = m.firstKeystrokeP95Ms;
  if (p95 === undefined || !Number.isFinite(p95)) {
    checks.push({ name: "first-keystroke p95", ok: false, gated: true, detail: "not measured" });
  } else {
    const allowed = allowedKeystrokeP95(base);
    checks.push({
      name: "first-keystroke p95 vs baseline", gated: true, ok: p95 <= allowed,
      detail: `${p95.toFixed(2)} ms measured, baseline ${base.firstKeystrokeP95Ms.toFixed(2)} ms, allowed ${allowed.toFixed(2)} ms (x${base.tolerance.factor} or +${base.tolerance.slackMs} ms, capped at ${base.firstKeystrokeCapMs} ms)`,
    });
    checks.push({ name: "first-keystroke p95 vs spec cap", gated: true, ok: p95 <= base.firstKeystrokeCapMs, detail: `${p95.toFixed(2)} ms against ${base.firstKeystrokeCapMs} ms` });
  }
  const pty = m.firstKeystrokePtyP95Ms;
  if (pty !== undefined) {
    checks.push({ name: "first-keystroke p95 (pty) vs spec cap", gated: true, ok: pty <= base.firstKeystrokeCapMs, detail: `${pty.toFixed(2)} ms against ${base.firstKeystrokeCapMs} ms` });
  }

  for (const mode of ["direct_only", "script_only"] as const) {
    for (const part of ["systemChars", "toolsChars"] as const) {
      const got = res.basePrompt[mode][part];
      const max = budget[mode][part];
      checks.push({ name: `base prompt ${mode} ${part}`, gated: true, ok: got <= max, detail: `${got} chars, budget ${max}, baseline ${base.basePrompt[mode][part]}` });
    }
  }
  checks.push({
    name: "base prompt context blocks", gated: true, ok: res.basePrompt.contextChars <= budget.contextChars,
    detail: `${res.basePrompt.contextChars} chars, budget ${budget.contextChars}, baseline ${base.basePrompt.contextChars}`,
  });

  for (const key of Object.keys(TARGETS) as MetricKey[]) {
    if (key === "firstKeystrokeP95Ms" || key === "firstKeystrokePtyP95Ms") continue;
    const v = m[key];
    const t = TARGETS[key];
    if (v === undefined) { checks.push({ name: t.label, ok: true, gated: false, detail: "not measured" }); continue; }
    const rec = base.recorded[key];
    checks.push({ name: t.label, ok: v <= t.target, gated: false, detail: `${v.toFixed(2)} ${t.unit}, target ${t.spec}${rec !== undefined ? `, recorded ${rec.toFixed(2)}` : ""}` });
  }

  const ok = checks.every((c) => c.ok || !c.gated);
  return { ok, checks, markdown: toMarkdown(res, checks, ok) };
}

export function toMarkdown(res: PerfResults, checks: Check[], ok: boolean): string {
  const lines = [`# Rigwell perf gate: ${ok ? "PASS" : "FAIL"}`, "", "| Check | Gated | Result | Detail |", "| --- | --- | --- | --- |"];
  for (const c of checks) lines.push(`| ${c.name} | ${c.gated ? "yes" : "no"} | ${c.ok ? "ok" : c.gated ? "FAIL" : "over target"} | ${c.detail} |`);
  if (res.notes?.length) lines.push("", "Method notes:", ...res.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}
