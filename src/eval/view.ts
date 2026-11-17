import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "./store.ts";
import { buildReport } from "./report.ts";
import type { RunRecord } from "./types.ts";
import { configuredSecretValues, redactSharedValue } from "../sharing/redact.ts";
import { unlinkedPath } from "../sync/target.ts";
import { encodeCsv, RESULT_HEADERS } from "./csv.ts";
import { importDataset, listDatasets, previewDataset, readDataset } from "./datasets.ts";
import { parseSharedSession } from "../sharing/format.ts";

function entries() {
  const found: { id: string; run: RunRecord }[] = [], warnings: string[] = []; let builds: string[] = [];
  try { builds = readdirSync(unlinkedPath(runsDir())); } catch { return { found, warnings }; }
  for (const build of builds) {
    const dir = join(runsDir(), build); let files: string[] = [];
    try { unlinkedPath(dir); if (!lstatSync(dir).isDirectory()) continue; files = readdirSync(dir); } catch { warnings.push(`Unreadable run folder: ${build}`); continue; }
    for (const name of files.filter((f) => f.endsWith(".json"))) try {
      const file = unlinkedPath(join(dir, name)), st = lstatSync(file); if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error("not a bounded regular file");
      const run = JSON.parse(readFileSync(file, "utf8"));
      if (run?.schema !== 1 || typeof run.buildId !== "string" || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.finishedAt)) || !Array.isArray(run.results) || run.results.length > 10000) throw new Error("invalid run metadata");
      for (const r of run.results) if (!r || ![r.task, r.model, r.variant, r.graderDetail, r.turnReason].every((s) => typeof s === "string") || typeof r.passed !== "boolean" || ![r.trial, r.wallMs, r.requests, r.tokens?.input, r.tokens?.output, r.tokens?.cacheRead, r.tokens?.cacheCreation, r.costUsd, r.cacheHitRate].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("invalid trial");
      for (const r of run.results) {
        if ([r.output, r.transcriptUnavailable, r.sessionId].some((s) => s !== undefined && typeof s !== "string") || (r.checkPassed !== undefined && typeof r.checkPassed !== "boolean")) throw new Error("invalid trial evidence");
        if (r.transcript !== undefined) r.transcript = parseSharedSession(JSON.stringify(r.transcript));
        if (r.judge !== undefined && (!r.judge || typeof r.judge.model !== "string" || typeof r.judge.reason !== "string" || !["complete", "error"].includes(r.judge.status) || (r.judge.status === "complete" ? typeof r.judge.score !== "number" || !Number.isFinite(r.judge.score) || r.judge.score < 0 || r.judge.score > 1 : r.judge.score !== null) || (r.judge.costUsd !== null && (typeof r.judge.costUsd !== "number" || !Number.isFinite(r.judge.costUsd) || r.judge.costUsd < 0)))) throw new Error("invalid judge evidence");
      }
      found.push({ id: createHash("sha256").update(`${build}/${name}`).digest("hex"), run });
    } catch { warnings.push(`Skipped invalid or linked run: ${build}/${name}`); }
  }
  return { found: found.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt)), warnings };
}
export function listEvalRuns() {
  const { found, warnings } = entries(); return { runs: found.map(({ id, run }) => ({ id, buildId: run.buildId, startedAt: run.startedAt, finishedAt: run.finishedAt, trials: run.results.length, passed: run.results.filter((r) => r.passed).length, meanWallMs: run.results.length ? run.results.reduce((n, r) => n + r.wallMs, 0) / run.results.length : null, costUsd: run.results.every((r) => r.priced) ? run.results.reduce((n, r) => n + r.costUsd, 0) : null, models: [...new Set(run.results.map((r) => r.model))] })), warnings };
}
export function readEvalRun(id: string) {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid evaluation run id");
  const entry = entries().found.find((e) => e.id === id); if (!entry) throw new Error("Evaluation run not found");
  const run = redactSharedValue(entry.run, configuredSecretValues(process.cwd())) as RunRecord;
  return { id, run, report: buildReport(run) };
}
export function compareEvalTrials(leftId: string, leftIndex: number, rightId: string, rightIndex: number) {
  const left = readEvalRun(leftId).run.results[leftIndex], right = readEvalRun(rightId).run.results[rightIndex];
  if (!Number.isSafeInteger(leftIndex) || !Number.isSafeInteger(rightIndex) || !left || !right) throw new Error("Select valid trial rows");
  if (left.task !== right.task) throw new Error("Compare outputs for the same task");
  return { task: left.task, left, right };
}
export function exportEvalRun(id: string, format: string) {
  const { run } = readEvalRun(id);
  if (format === "jsonl") return { format, content: run.results.map((trial) => JSON.stringify({ schema: 1, buildId: run.buildId, startedAt: run.startedAt, ...trial })).join("\n") + "\n" };
  if (format !== "csv") throw new Error("Choose CSV or JSONL");
  return { format, content: encodeCsv([RESULT_HEADERS, ...run.results.map((r) => [run.buildId, run.startedAt, r.task, r.model, r.variant, r.trial, r.passed, r.failKind, r.wallMs, r.requests, r.tokens.input, r.tokens.output, r.tokens.cacheRead, r.tokens.cacheCreation, r.priced ? r.costUsd : "", r.priced, r.checkPassed ?? "", r.judge?.model ?? "", r.judge?.score ?? "", r.judge?.status ?? "", r.output ?? "", r.transcript ? JSON.stringify(r.transcript) : r.transcriptUnavailable ?? "Transcript unavailable"])]) };
}
export const evalMethods = {
  list_eval_runs: () => listEvalRuns(), read_eval_run: (p: any) => readEvalRun(p.id), compare_eval_trials: (p: any) => compareEvalTrials(p.leftId, p.leftIndex, p.rightId, p.rightIndex), export_eval_run: (p: any) => exportEvalRun(p.id, p.format),
  list_eval_datasets: () => ({ datasets: listDatasets() }), read_eval_dataset: (p: any) => readDataset(p.id),
  preview_eval_dataset: (p: any) => { const preview = previewDataset(p.source, p.format, p.columns); return { ...preview, count: preview.rows.length, rows: preview.rows.slice(0, 10) }; },
  import_eval_dataset: (p: any) => { const d = importDataset(p); return { id: d.id, name: d.name, count: d.rows.length, staxVerified: false }; },
};
