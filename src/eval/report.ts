// Report: compare a run to the previous build's latest run (spec section 8, tracking list).
import type { RunRecord, TrialResult } from "./types.ts";

export interface Thresholds {
  /** Flag when mean cost per trial rises by more than this fraction. */
  costRise: number;
  /** Flag when mean wall time per trial rises by more than this fraction. */
  timeRise: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { costRise: 0.2, timeRise: 0.25 };

export interface GroupStats {
  trials: number;
  passed: number;
  passRate: number;
  meanCostUsd: number;
  /** Total cost / passed trials; null when nothing passed. */
  costPerPassUsd: number | null;
  meanWallMs: number;
  /** Mean wall time of passing trials; null when nothing passed. */
  wallPerPassMs: number | null;
  meanRequests: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  cacheHitRate: number;
  priced: boolean;
}

export interface Paired {
  tasks: string[];
  cur: { meanCostUsd: number; meanWallMs: number };
  prev: { meanCostUsd: number; meanWallMs: number };
  costPct: number | null;
  wallPct: number | null;
}

export interface GroupReport {
  model: string;
  family: string;
  variant: string;
  stats: GroupStats;
  prev?: GroupStats;
  deltas?: { passRatePp: number; meanCostPct: number | null; meanWallPct: number | null };
  /** Tasks that passed every trial in both builds: the only fair cost/time comparison (spec section 8). */
  paired?: Paired;
}

export interface TaskRow { task: string; model: string; variant: string; passRate: number; prevPassRate: number | null }

export interface Cluster { signature: string; failKind: string; tasks: string[]; models: string[]; count: number }

export interface VariantVerdictModel {
  model: string;
  family: string;
  baselinePassRate: number;
  candidatePassRate: number;
  pairedTasks: number;
  costPct: number | null;
  wallPct: number | null;
  outcome: "better" | "worse" | "neutral";
}
export interface VariantExperiment {
  variant: string;
  models: VariantVerdictModel[];
  decision: "ship" | "per-model option" | "do not ship";
  note: string;
}

export interface Report {
  current: { buildId: string; startedAt: string };
  previous: { buildId: string; startedAt: string } | null;
  groups: GroupReport[];
  tasks: TaskRow[];
  regressions: string[];
  improvements: string[];
  clusters: Cluster[];
  experiments: VariantExperiment[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (cur: number, prev: number): number | null => (prev > 0 ? (cur - prev) / prev : null);
const keyOf = (r: TrialResult) => `${r.model}\u0000${r.variant}`;

export function groupStats(rs: TrialResult[]): GroupStats {
  const passed = rs.filter((r) => r.passed);
  const totalCost = rs.reduce((a, r) => a + r.costUsd, 0);
  const inTok = rs.map((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheCreation);
  const cached = rs.reduce((a, r) => a + r.tokens.cacheRead, 0);
  const inSum = inTok.reduce((a, b) => a + b, 0);
  return {
    trials: rs.length,
    passed: passed.length,
    passRate: rs.length ? passed.length / rs.length : 0,
    meanCostUsd: mean(rs.map((r) => r.costUsd)),
    costPerPassUsd: passed.length ? totalCost / passed.length : null,
    meanWallMs: mean(rs.map((r) => r.wallMs)),
    wallPerPassMs: passed.length ? mean(passed.map((r) => r.wallMs)) : null,
    meanRequests: mean(rs.map((r) => r.requests)),
    meanInputTokens: mean(inTok),
    meanOutputTokens: mean(rs.map((r) => r.tokens.output)),
    cacheHitRate: inSum ? cached / inSum : 0,
    priced: rs.length > 0 && rs.every((r) => r.priced),
  };
}

/** Tasks where every trial passed. */
function solidTasks(rs: TrialResult[]): Set<string> {
  const by = new Map<string, boolean>();
  for (const r of rs) by.set(r.task, (by.get(r.task) ?? true) && r.passed);
  return new Set([...by].filter(([, ok]) => ok).map(([t]) => t));
}

function pairedStats(cur: TrialResult[], prev: TrialResult[]): Paired | undefined {
  const a = solidTasks(cur);
  const b = solidTasks(prev);
  const tasks = [...a].filter((t) => b.has(t)).sort();
  if (!tasks.length) return undefined;
  const c = cur.filter((r) => tasks.includes(r.task));
  const p = prev.filter((r) => tasks.includes(r.task));
  const cm = { meanCostUsd: mean(c.map((r) => r.costUsd)), meanWallMs: mean(c.map((r) => r.wallMs)) };
  const pm = { meanCostUsd: mean(p.map((r) => r.costUsd)), meanWallMs: mean(p.map((r) => r.wallMs)) };
  return { tasks, cur: cm, prev: pm, costPct: pct(cm.meanCostUsd, pm.meanCostUsd), wallPct: pct(cm.meanWallMs, pm.meanWallMs) };
}

export interface SelectOpts { sinceMs?: number; now?: number; build?: string; against?: string }

/** Picks the run to report and the previous build's latest run. */
export function selectRuns(runs: RunRecord[], o: SelectOpts = {}): { current?: RunRecord; previous?: RunRecord } {
  const sorted = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const latest = (xs: RunRecord[]) => xs[xs.length - 1];
  let pool = sorted;
  if (o.build) pool = pool.filter((r) => r.buildId === o.build);
  if (o.sinceMs !== undefined) {
    const cutoff = new Date((o.now ?? Date.now()) - o.sinceMs).toISOString();
    pool = pool.filter((r) => r.startedAt >= cutoff);
  }
  const current = latest(pool);
  if (!current) return {};
  const earlier = sorted.filter((r) => r.buildId !== current.buildId && r.startedAt < current.startedAt);
  const previous = o.against ? latest(sorted.filter((r) => r.buildId === o.against)) : latest(earlier);
  return { current, previous };
}

function clusterFailures(results: TrialResult[]): Cluster[] {
  const map = new Map<string, TrialResult[]>();
  for (const r of results) {
    if (r.passed) continue;
    const detail = r.graderDetail.split("|")[0]!.replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 80);
    const sig = `${r.failKind}/${r.turnReason}: ${detail}`;
    (map.get(sig) ?? map.set(sig, []).get(sig)!).push(r);
  }
  const out: Cluster[] = [];
  for (const [signature, rs] of map) {
    const tasks = [...new Set(rs.map((r) => r.task))].sort();
    const models = [...new Set(rs.map((r) => r.model))].sort();
    // Spec section 8 step 3: failures that repeat across tasks AND models.
    if (tasks.length >= 2 && models.length >= 2) out.push({ signature, failKind: rs[0]!.failKind, tasks, models, count: rs.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

function experiments(results: TrialResult[]): VariantExperiment[] {
  const variants = [...new Set(results.map((r) => r.variant))];
  if (!variants.includes("baseline")) return [];
  const out: VariantExperiment[] = [];
  for (const variant of variants.filter((v) => v !== "baseline")) {
    const models: VariantVerdictModel[] = [];
    for (const model of [...new Set(results.filter((r) => r.variant === variant).map((r) => r.model))]) {
      const base = results.filter((r) => r.model === model && r.variant === "baseline");
      const cand = results.filter((r) => r.model === model && r.variant === variant);
      if (!base.length || !cand.length) continue;
      const bs = groupStats(base);
      const cs = groupStats(cand);
      const paired = pairedStats(cand, base);
      let outcome: VariantVerdictModel["outcome"] = "neutral";
      if (cs.passRate < bs.passRate) outcome = "worse";
      else if (cs.passRate > bs.passRate) outcome = "better";
      else if (paired?.costPct != null && paired.costPct <= -0.05) outcome = "better";
      else if (paired?.costPct != null && paired.costPct >= 0.05) outcome = "worse";
      models.push({
        model, family: cand[0]!.family, baselinePassRate: bs.passRate, candidatePassRate: cs.passRate,
        pairedTasks: paired?.tasks.length ?? 0, costPct: paired?.costPct ?? null, wallPct: paired?.wallPct ?? null, outcome,
      });
    }
    if (!models.length) continue;
    // Family verdict: worse if any member is worse, better if none worse and one better.
    const fams = new Map<string, VariantVerdictModel[]>();
    for (const m of models) (fams.get(m.family) ?? fams.set(m.family, []).get(m.family)!).push(m);
    const famOutcome = new Map<string, "better" | "worse" | "neutral">();
    for (const [f, ms] of fams) famOutcome.set(f, ms.some((m) => m.outcome === "worse") ? "worse" : ms.some((m) => m.outcome === "better") ? "better" : "neutral");
    const outs = [...famOutcome.values()];
    const better = [...famOutcome].filter(([, o]) => o === "better").map(([f]) => f);
    const worse = [...famOutcome].filter(([, o]) => o === "worse").map(([f]) => f);
    let decision: VariantExperiment["decision"];
    let note: string;
    if (!worse.length && better.length) { decision = "ship"; note = `Holds on all ${outs.length} model famil${outs.length === 1 ? "y" : "ies"}.`; }
    else if (worse.length && better.length) { decision = "per-model option"; note = `Better on ${better.join(", ")}; worse on ${worse.join(", ")}.`; }
    else { decision = "do not ship"; note = worse.length ? `Worse on ${worse.join(", ")}.` : "No measurable gain."; }
    out.push({ variant, models, decision, note: note + " Human review decides what ships." });
  }
  return out;
}

export function buildReport(current: RunRecord, previous?: RunRecord, th: Thresholds = DEFAULT_THRESHOLDS): Report {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const groups: GroupReport[] = [];
  const keys = [...new Set(current.results.map(keyOf))];
  for (const k of keys) {
    const cur = current.results.filter((r) => keyOf(r) === k);
    const prev = previous?.results.filter((r) => keyOf(r) === k) ?? [];
    const g: GroupReport = { model: cur[0]!.model, family: cur[0]!.family, variant: cur[0]!.variant, stats: groupStats(cur) };
    const label = `${g.model} [${g.variant}]`;
    if (prev.length) {
      g.prev = groupStats(prev);
      g.deltas = {
        passRatePp: (g.stats.passRate - g.prev.passRate) * 100,
        meanCostPct: g.stats.priced && g.prev.priced ? pct(g.stats.meanCostUsd, g.prev.meanCostUsd) : null,
        meanWallPct: pct(g.stats.meanWallMs, g.prev.meanWallMs),
      };
      g.paired = pairedStats(cur, prev);
      if (g.deltas.passRatePp < -1e-9) regressions.push(`${label}: pass rate ${(g.prev.passRate * 100).toFixed(0)}% -> ${(g.stats.passRate * 100).toFixed(0)}%`);
      else if (g.deltas.passRatePp > 1e-9) improvements.push(`${label}: pass rate ${(g.prev.passRate * 100).toFixed(0)}% -> ${(g.stats.passRate * 100).toFixed(0)}%`);
      const costBase = g.paired?.costPct ?? g.deltas.meanCostPct;
      if (g.stats.priced && g.prev.priced && costBase != null && costBase > th.costRise)
        regressions.push(`${label}: mean cost up ${(costBase * 100).toFixed(0)}%${g.paired ? " (on tasks both builds passed)" : ""}`);
      const timeBase = g.paired?.wallPct ?? g.deltas.meanWallPct;
      if (timeBase != null && timeBase > th.timeRise)
        regressions.push(`${label}: mean time up ${(timeBase * 100).toFixed(0)}%${g.paired ? " (on tasks both builds passed)" : ""}`);
    }
    groups.push(g);
  }
  // Per-task rows, flagging tasks that passed before and fail now.
  const rows: TaskRow[] = [];
  const taskKeys = [...new Set(current.results.map((r) => `${r.task}\u0000${keyOf(r)}`))];
  for (const tk of taskKeys) {
    const [task, model, variant] = tk.split("\u0000") as [string, string, string];
    const cur = current.results.filter((r) => r.task === task && r.model === model && r.variant === variant);
    const prev = previous?.results.filter((r) => r.task === task && r.model === model && r.variant === variant) ?? [];
    const row: TaskRow = { task, model, variant, passRate: cur.filter((r) => r.passed).length / cur.length, prevPassRate: prev.length ? prev.filter((r) => r.passed).length / prev.length : null };
    if (row.prevPassRate !== null && row.passRate < row.prevPassRate) regressions.push(`${task} on ${model} [${variant}]: was ${(row.prevPassRate * 100).toFixed(0)}%, now ${(row.passRate * 100).toFixed(0)}%`);
    rows.push(row);
  }
  return {
    current: { buildId: current.buildId, startedAt: current.startedAt },
    previous: previous ? { buildId: previous.buildId, startedAt: previous.startedAt } : null,
    groups, tasks: rows, regressions, improvements, clusters: clusterFailures(current.results), experiments: experiments(current.results),
  };
}

const p0 = (x: number) => `${(x * 100).toFixed(0)}%`;
const usd = (x: number) => `$${x.toFixed(x < 0.01 ? 5 : 4)}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const sgn = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
const pp = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}pp`;

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`# Rigwell eval report`);
  L.push("");
  L.push(`Build \`${r.current.buildId}\` (run ${r.current.startedAt})` + (r.previous ? ` vs previous build \`${r.previous.buildId}\` (run ${r.previous.startedAt}).` : ". No previous build to compare against."));
  L.push("");
  L.push(`## Regressions`);
  L.push("");
  if (r.regressions.length) for (const x of r.regressions) L.push(`- REGRESSION ${x}`);
  else L.push(r.previous ? "None." : "Nothing to compare yet.");
  if (r.improvements.length) { L.push(""); L.push("Improvements:"); for (const x of r.improvements) L.push(`- ${x}`); }
  L.push("");
  L.push(`## Per model`);
  L.push("");
  L.push(`| Model | Variant | Pass | Mean cost | Cost per pass | Mean time | Time per pass | Requests | Cache hit | Delta pass | Delta cost | Delta time |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const g of r.groups) {
    const s = g.stats;
    const cost = s.priced ? usd(s.meanCostUsd) : "unpriced";
    const cpp = s.priced && s.costPerPassUsd !== null ? usd(s.costPerPassUsd) : "n/a";
    const d = g.deltas;
    L.push(`| ${g.model} | ${g.variant} | ${s.passed}/${s.trials} (${p0(s.passRate)}) | ${cost} | ${cpp} | ${sec(s.meanWallMs)} | ${s.wallPerPassMs === null ? "n/a" : sec(s.wallPerPassMs)} | ${s.meanRequests.toFixed(1)} | ${p0(s.cacheHitRate)} | ${d ? pp(d.passRatePp) : "n/a"} | ${d ? sgn(d.meanCostPct) : "n/a"} | ${d ? sgn(d.meanWallPct) : "n/a"} |`);
  }
  const paired = r.groups.filter((g) => g.paired);
  if (paired.length) {
    L.push("");
    L.push(`### Tasks both builds passed (fair cost and time comparison)`);
    L.push("");
    L.push(`| Model | Variant | Tasks | Cost now | Cost before | Delta cost | Time now | Time before | Delta time |`);
    L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const g of paired) {
      const p = g.paired!;
      L.push(`| ${g.model} | ${g.variant} | ${p.tasks.length} | ${usd(p.cur.meanCostUsd)} | ${usd(p.prev.meanCostUsd)} | ${sgn(p.costPct)} | ${sec(p.cur.meanWallMs)} | ${sec(p.prev.meanWallMs)} | ${sgn(p.wallPct)} |`);
    }
  }
  L.push("");
  L.push(`## Per task`);
  L.push("");
  L.push(`| Task | Model | Variant | Pass rate | Previous |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const t of r.tasks) L.push(`| ${t.task} | ${t.model} | ${t.variant} | ${p0(t.passRate)} | ${t.prevPassRate === null ? "n/a" : p0(t.prevPassRate)} |`);
  L.push("");
  L.push(`## Failure clusters (repeat across tasks and models)`);
  L.push("");
  if (r.clusters.length) for (const c of r.clusters) L.push(`- ${c.count}x \`${c.signature}\` on tasks ${c.tasks.join(", ")}; models ${c.models.join(", ")}`);
  else L.push("None.");
  if (r.experiments.length) {
    L.push("");
    L.push(`## Variant experiments`);
    for (const e of r.experiments) {
      L.push("");
      L.push(`### ${e.variant}: ${e.decision}`);
      L.push("");
      L.push(e.note);
      L.push("");
      L.push(`| Model | Family | Baseline pass | Variant pass | Paired tasks | Delta cost | Delta time | Outcome |`);
      L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
      for (const m of e.models) L.push(`| ${m.model} | ${m.family} | ${p0(m.baselinePassRate)} | ${p0(m.candidatePassRate)} | ${m.pairedTasks} | ${sgn(m.costPct)} | ${sgn(m.wallPct)} | ${m.outcome} |`);
    }
  }
  L.push("");
  return L.join("\n");
}

/** "7d", "12h", "90m" -> ms. */
export function parseSince(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([dhm])$/.exec(s.trim());
  if (!m) throw new Error(`bad --since value "${s}" (use e.g. 7d, 12h, 90m)`);
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "h" | "m"];
}
