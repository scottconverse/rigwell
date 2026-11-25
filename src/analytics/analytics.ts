import { closeSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { cleanUsage, USAGE_KEYS } from "../storage/analytics-records.ts";
import { openSessionIndex, refreshIndex } from "../storage/session-index.ts";
import { loadSettings } from "../storage/settings.ts";
import { rigwellHome } from "../storage/paths.ts";
import { costOf } from "../eval/cost.ts";
import type { Price } from "../eval/types.ts";
import { automationsRoot, projectAutomationsRoot, type RunRecord } from "../automations/store.ts";
import { readProjectRegistry } from "../automations/projects.ts";
import { MissionStore, missionsRoot } from "../missions/store.ts";
import { CSV_KEYS, csvRows } from "./csv.ts";
import { badges, localStats, localWeekend, type LocalStats, type StatSession } from "./stats.ts";

export interface AnalyticsQuery { group?: "day" | "model" | "project" | "session"; from?: string; to?: string; model?: string; project?: string; session?: string }
const UNKNOWN = "Unattributed", UNDATED = "Undated";
function filters(raw: AnalyticsQuery) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid analytics filters");
  const group = raw.group ?? "day";
  if (!["day", "model", "project", "session"].includes(group)) throw new Error("Invalid analytics grouping");
  for (const key of ["model", "project", "session"] as const) if (raw[key] !== undefined && (typeof raw[key] !== "string" || raw[key]!.length > 2048)) throw new Error("Invalid analytics filter");
  for (const date of [raw.from, raw.to]) if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error("Use a valid UTC date");
  if (raw.from && raw.to && raw.from > raw.to) throw new Error("Start date must precede end date");
  return { ...raw, group };
}
function empty(key: string) { return { key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0, requests: 0, turns: 0, durationMs: 0, tools: 0, successes: 0, failures: 0, unknown: 0, pricedCostUsd: 0, unpricedTokens: 0 }; }
type Counts = ReturnType<typeof empty>;
function finish(row: Counts) {
  const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens, input = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens, settled = row.successes + row.failures;
  return { ...row, tokens, costUsd: row.unpricedTokens ? null : row.pricedCostUsd, cacheHitRate: input ? row.cacheReadTokens / input : null, failureRate: settled ? row.failures / settled : null, meanTurnMs: row.turns ? row.durationMs / row.turns : null };
}
export function configuredPrices(): Record<string, Price> {
  const raw = (loadSettings({ cwd: rigwellHome(), trusted: false }).settings.analytics as any)?.prices ?? {}, prices: Record<string, Price> = Object.create(null);
  for (const [id, p] of Object.entries(raw) as [string, any][]) if (p && [p.inputPerMtok, p.outputPerMtok, p.cachedInputPerMtok, p.cacheWritePerMtok ?? p.inputPerMtok].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) prices[id] = p;
  return prices;
}
interface Observation { session: string; project: string; model: string; timestamp: number | null; data: any }
function runRates(q: ReturnType<typeof filters>) {
  const within = (t: number) => Number.isFinite(t) && (!q.from || t >= Date.parse(q.from)) && (!q.to || t < Date.parse(q.to) + 86_400_000);
  const automation = { success: 0, failure: 0, cancelled: 0, inProgress: 0, rate: null as number | null };
  const mission = { completed: 0, other: 0, workerSuccess: 0, workerPartial: 0, workerFailure: 0, workerRate: null as number | null };
  // Run stores retain the most recent fifty records per automation. Never label this all-time history.
  const roots = [automationsRoot(), ...readProjectRegistry().map(projectAutomationsRoot)], autos = new Map<string, RunRecord[]>();
  for (const root of new Set(roots)) {
    let folders: string[] = []; try { folders = readdirSync(root); } catch { /* none yet */ }
    for (const folder of folders) try {
      const dir = join(root, folder), state = JSON.parse(readFileSync(join(dir, "memory/state.json"), "utf8")), runs = JSON.parse(readFileSync(join(dir, "memory/runs.json"), "utf8"));
      if (typeof state.id === "string" && Array.isArray(runs)) autos.set(state.id, runs);
    } catch { /* absent or unreadable history cannot establish outcomes */ }
  }
  for (const runs of autos.values()) for (const run of new Map(runs.filter((r) => r && typeof r.runId === "string").map((r) => [r.runId, r])).values()) {
    if (q.model || q.project || q.session || !within(run.startedAt)) continue; // These stores do not reliably retain per-run project/model attribution.
    if (run.status === "success") automation.success++; else if (run.status === "failure") automation.failure++; else if (run.status === "cancelled") automation.cancelled++; else if (run.status === "in_progress") automation.inProgress++;
  }
  let dirs: string[] = []; try { dirs = readdirSync(missionsRoot()); } catch { /* none yet */ }
  for (const id of dirs) {
    const store = new MissionStore(join(missionsRoot(), id)), state = store.readState(); if (!state) continue;
    if (q.model || (q.session && q.session !== id) || (q.project && q.project !== state.workingDirectory)) continue;
    if (within(Date.parse(state.updatedAt))) { if (state.state === "completed") mission.completed++; else mission.other++; }
    const workers = new Map<string, any>();
    for (const event of store.readLog()) if (["worker_completed", "worker_failed"].includes(event.type) && typeof event.workerSessionId === "string") workers.set(event.workerSessionId, event);
    for (const event of workers.values()) if (within(Date.parse(event.timestamp))) {
      if (event.type === "worker_failed" || event.successState === "failure") mission.workerFailure++;
      else if (event.successState === "partial") mission.workerPartial++;
      else if (event.successState === "success") mission.workerSuccess++;
    }
  }
  const autoTotal = automation.success + automation.failure, workers = mission.workerSuccess + mission.workerPartial + mission.workerFailure;
  automation.rate = autoTotal ? automation.success / autoTotal : null; mission.workerRate = workers ? mission.workerSuccess / workers : null;
  return { automation, mission };
}

const ownWorkCache = new Map<string, boolean>();
/** True when this transcript's first visible user message is not the user's own work. Reads at most 1 MiB, complete lines only. */
export function notOwnWork(file: string): boolean {
  const cached = ownWorkCache.get(file);
  if (cached !== undefined) return cached;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8");
    let total = 0, pending = "";
    while (total < 1024 * 1024) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, 1024 * 1024 - total), total);
      if (n <= 0) break;
      total += n;
      pending += decoder.decode(buffer.subarray(0, n), { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? ""; // the last piece is an incomplete line
      for (const line of lines) {
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        const m = o?.message;
        if (o?.type !== "message" || m?.role !== "user" || m.visibility === "llm_only" || m.visibility === "user_only" || String(o.id ?? "").startsWith("context-")) continue;
        const id = String(o.id ?? ""), source = m.userMessageSource;
        const verdict = source === "automation" || source === "sdk" || id.startsWith("workstream-initial-") || id === "eval-turn";
        ownWorkCache.set(file, verdict);
        return verdict;
      }
    }
    return false;
  } catch { return false; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

export function readAnalytics(raw: AnalyticsQuery = {}) {
  const q = filters(raw), prices = configuredPrices(), db = openSessionIndex(), observations: Observation[] = [], choices = { models: new Set<string>(), projects: new Set<string>(), sessions: new Set<string>() };
  let legacyForks = 0, skippedLines = 0, stats: LocalStats = { sessions: 0, activeMs: 0, longestMs: 0, weekendSessions: 0 };
  try {
    refreshIndex(db);
    const sessions = db.query("SELECT s.session_id, s.cwd, a.* FROM sessions s JOIN session_analytics a USING(session_id)").all() as any[];
    for (const session of sessions) {
      const events = db.query("SELECT timestamp, data FROM analytics_events WHERE session_id = ? ORDER BY line_number, slot").all(session.session_id) as any[];
      const ownUsage = cleanUsage({}), settings = cleanUsage(JSON.parse(session.settings_usage)), inherited = cleanUsage(JSON.parse(session.inherited_usage));
      let model = UNKNOWN;
      // Old forks lack a reliable copied-record boundary. Only new accounting observations establish new execution.
      const boundary = session.legacy_fork ? events.find((e) => JSON.parse(e.data).kind === "usage")?.timestamp ?? Infinity : -Infinity;
      if (session.legacy_fork) legacyForks++;
      for (const event of events) {
        const data = JSON.parse(event.data);
        if (session.legacy_fork && (event.timestamp === null || event.timestamp < boundary)) continue;
        if (data.kind === "usage") { for (const key of USAGE_KEYS) ownUsage[key] += data.usage[key]; if (data.purpose === "answer") model = data.model; }
        observations.push({ session: session.session_id, project: session.cwd ?? UNKNOWN, model: typeof data.model === "string" ? data.model : model, timestamp: event.timestamp, data });
      }
      if (!session.legacy_fork) {
        const usage = cleanUsage(Object.fromEntries(USAGE_KEYS.map((key) => [key, Math.max(0, settings[key] - inherited[key] - ownUsage[key])])));
        if (USAGE_KEYS.some((key) => usage[key])) observations.push({ session: session.session_id, project: session.cwd ?? UNKNOWN, model: UNKNOWN, timestamp: null, data: { kind: "usage", usage, purpose: "legacy", legacy: true } });
      }
    }
    skippedLines = (db.query("SELECT COALESCE(SUM(transcript_skipped_lines),0) n FROM session_ingest").get() as any).n;
    const list: StatSession[] = [];
    const roots = db.query("SELECT session_id, first_event_at, last_event_at, transcript_path, tags FROM sessions WHERE parent IS NULL AND calling_session_id IS NULL AND has_user_visible_messages = 1 AND first_event_at IS NOT NULL").all() as any[];
    for (const row of roots) {
      let tags: any = null; try { tags = JSON.parse(row.tags); } catch { /* bad JSON means no tags */ }
      if (tags && tags.exec) continue;
      if (notOwnWork(row.transcript_path)) continue;
      const times = (db.query("SELECT timestamp FROM analytics_events WHERE session_id = ? AND timestamp IS NOT NULL").all(row.session_id) as any[]).map((e) => e.timestamp);
      times.push(row.first_event_at); if (row.last_event_at !== null) times.push(row.last_event_at);
      list.push({ times, firstAt: row.first_event_at });
    }
    stats = localStats(list, localWeekend);
  } finally { db.close(); }
  const groups = new Map<string, Counts>(), tools = new Map<string, Counts & { source: string }>(), total = empty("Total");
  let undatedExcluded = 0;
  const accept = (o: Observation) => {
    if (q.project && q.project !== o.project || q.model && q.model !== o.model || q.session && q.session !== o.session) return false;
    if ((q.from || q.to) && o.timestamp === null) { undatedExcluded++; return false; }
    return !(q.from && o.timestamp! < Date.parse(q.from) || q.to && o.timestamp! >= Date.parse(q.to) + 86_400_000);
  };
  const targets = (o: Observation) => {
    const key = q.group === "day" ? o.timestamp === null ? UNDATED : new Date(o.timestamp).toISOString().slice(0, 10) : o[q.group as "model" | "project" | "session"];
    let row = groups.get(key); if (!row) groups.set(key, row = empty(key)); return [row, total];
  };
  const calls = new Map<string, Observation>();
  for (const o of observations) {
    choices.models.add(o.model); choices.projects.add(o.project); choices.sessions.add(o.session);
    const d = o.data;
    if (d.kind === "tool" || d.kind === "result") {
      const key = `${o.session}:${d.id}`, prev = calls.get(key);
      if (d.kind === "tool") { if (!prev) calls.set(key, o); else if (d.status !== "started") prev.data = { ...prev.data, status: d.status }; }
      else if (prev) prev.data = { ...prev.data, status: d.status };
      continue;
    }
    if (!accept(o)) continue;
    for (const row of targets(o)) {
      if (d.kind === "usage") {
        for (const key of USAGE_KEYS) row[key] += d.usage[key];
        if (!d.legacy) row.requests++;
        const tokens = d.usage.inputTokens + d.usage.outputTokens + d.usage.cacheReadTokens + d.usage.cacheCreationTokens;
        const price = prices[o.model]; if (!price) row.unpricedTokens += tokens;
        else row.pricedCostUsd += costOf({ input: d.usage.inputTokens, output: d.usage.outputTokens, cacheRead: d.usage.cacheReadTokens, cacheCreation: d.usage.cacheCreationTokens }, price);
      } else if (d.kind === "turn") { row.turns++; row.durationMs += d.durationMs; }
    }
  }
  for (const o of calls.values()) if (accept(o)) {
    const d = o.data, toolKey = JSON.stringify([d.source, d.name]); let tool = tools.get(toolKey);
    if (!tool) tools.set(toolKey, tool = { ...empty(d.name), source: d.source });
    for (const row of [...targets(o), tool]) { row.tools++; if (d.status === "success") row.successes++; else if (d.status === "failure") row.failures++; else row.unknown++; }
  }
  return { query: q, totals: finish(total), rows: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(finish), tools: [...tools.values()].map((r) => ({ ...finish(r), source: r.source })), choices: Object.fromEntries(Object.entries(choices).map(([key, value]) => [key, [...value].sort()])) as Record<keyof typeof choices, string[]>, rates: runRates(q), coverage: { legacyForks, skippedLines, undatedExcluded }, stats: { ...stats, badges: badges(stats) }, generatedAt: new Date().toISOString() };
}

export function analyticsCsv(report: ReturnType<typeof readAnalytics>) {
  const keys = CSV_KEYS;
  const lines: unknown[][] = [["section", "group", ...keys], ...report.rows.map((r) => ["usage", report.query.group, ...keys.map((k) => r[k])]), ...report.tools.map((r) => ["tools", r.source, ...keys.map((k) => r[k])])];
  for (const [kind, rates] of Object.entries(report.rates)) for (const [key, value] of Object.entries(rates)) lines.push(["rates", kind, key, value]);
  lines.push(["coverage", "legacyForks", report.coverage.legacyForks], ["coverage", "skippedLines", report.coverage.skippedLines], ["coverage", "undatedExcluded", report.coverage.undatedExcluded]);
  lines.push(["total", report.query.group, ...keys.map((key) => report.totals[key])]);
  for (const [key, value] of Object.entries(report.query)) lines.push(["filter", key, value]);
  return csvRows(lines);
}
export const analyticsMethods = {
  get_analytics: (p: AnalyticsQuery) => readAnalytics(p),
  export_analytics: (p: AnalyticsQuery) => ({ content: analyticsCsv(readAnalytics(p)), format: "csv" }),
};
