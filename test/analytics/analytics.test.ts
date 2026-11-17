import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { analyticsCsv, readAnalytics } from "../../src/analytics/analytics.ts";
import { openSessionIndex, refreshIndex, resetSessionIndex } from "../../src/storage/session-index.ts";
import { appendAnalyticsMetric, appendMessage, appendTurnOutcome, createSession, loadTranscript } from "../../src/storage/transcript.ts";
import { updateSessionSettings } from "../../src/storage/session-settings.ts";
import { forkSession } from "../../src/storage/fork.ts";
import { CSV_KEYS, csvRows, sanitizeAnalyticsCsv } from "../../src/analytics/csv.ts";
import { saveAnalyticsExport } from "../../desktop/main/analytics-export.ts";
import { makeStubSession, text } from "../agent/helpers.ts";
import { MissionStore, missionsRoot } from "../../src/missions/store.ts";

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 });
const record = (file: string, metric: object, timestamp = "2026-01-02T12:00:00Z") => appendFileSync(file, JSON.stringify({ type: "analytics_metric", timestamp, metric }) + "\n");

test("accounting groups exact own usage, costs, tools and turn times without counting copied forks or inclusive child totals", async () => {
  const env = tmpEnv(), cwd = join(env.root, "project"); mkdirSync(cwd);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { analytics: { prices: { first: { inputPerMtok: 1, outputPerMtok: 2, cachedInputPerMtok: .2, cacheWritePerMtok: 1.5 } } } });
    const f = createSession({ id: "parent", cwd });
    const u = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 10, thinkingTokens: 5 };
    record(f.transcriptPath, { kind: "usage", model: "first", purpose: "answer", usage: u });
    await appendMessage(f, { id: "a", role: "assistant", content: [{ type: "tool_use", id: "one", name: "Read", input: { path: "PRIVATE_ARGUMENT" } }, { type: "tool_use", id: "two", name: "Read", input: {} }] }, null);
    await appendMessage(f, { id: "b", role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "PRIVATE_RESULT", is_error: true }] }, "a");
    record(f.transcriptPath, { kind: "tool", id: "native-one", model: "native-profile", name: "command_execution", status: "started", source: "native" });
    record(f.transcriptPath, { kind: "tool", id: "native-one", model: "native-profile", name: "command_execution", status: "success", source: "native" });
    record(f.transcriptPath, { kind: "turn", id: "turn-one", reason: "completed", durationMs: 1200 });
    updateSessionSettings(f, { tokenUsage: { ...u, inputTokens: 130 }, inclusiveTokenUsage: usage(999999) });
    const fork = forkSession(f); record(fork.transcriptPath, { kind: "usage", model: "first", purpose: "answer", usage: usage(7) }); updateSessionSettings(fork, { tokenUsage: { ...u, inputTokens: 137 } });
    const child = createSession({ id: "child", cwd, extra: { callingSessionId: f.id } }); record(child.transcriptPath, { kind: "usage", model: "second", purpose: "answer", usage: usage(10) });
    const report = readAnalytics({ group: "model" });
    expect(report.totals.tokens).toBe(227); expect(report.totals.thinkingTokens).toBe(5); expect(report.totals.requests).toBe(3); expect(report.totals.costUsd).toBeNull(); expect(report.totals.pricedCostUsd).toBeCloseTo(.000172, 9); expect(report.totals.unpricedTokens).toBe(40);
    expect(report.rows.find((r) => r.key === "native-profile")?.tools).toBe(1); expect(report.rows.find((r) => r.key === "first")?.tokens).toBe(187); expect(report.rows.find((r) => r.key === "Unattributed")?.tokens).toBe(30);
    expect(report.totals).toMatchObject({ tools: 3, failures: 1, successes: 1, unknown: 1, turns: 1, durationMs: 1200, meanTurnMs: 1200, failureRate: .5 });
    expect(report.tools.find((r) => r.key === "Read")).toMatchObject({ tools: 2, failures: 1, unknown: 1, failureRate: 1 });
    expect(readAnalytics({ from: "2026-01-02", to: "2026-01-02" }).totals.tokens).toBe(197); expect(readAnalytics({ from: "2026-01-02" }).coverage.undatedExcluded).toBe(1);
    expect(readAnalytics({ session: fork.id }).totals.tokens).toBe(7); expect(readAnalytics({ project: cwd, model: "second" }).totals.tokens).toBe(10); expect(readAnalytics({ group: "project" }).rows[0]?.key).toBe(cwd);
    expect(readAnalytics().totals.tokens).toBe(227); // unchanged incremental refresh must not duplicate metrics
    const db = openSessionIndex(); const cached = JSON.stringify(db.query("SELECT data FROM analytics_events").all()); db.close(); expect(cached).not.toContain("PRIVATE_");
    resetSessionIndex(); expect(readAnalytics().totals.tokens).toBe(227); expect(loadTranscript(f).unknownRecords).toBe(0);
    const csv = analyticsCsv(report); expect(sanitizeAnalyticsCsv(csv)).toBe(csv); expect(csv).not.toContain("PRIVATE_"); expect(csv).toContain('"rates","automation"');
    expect(() => readAnalytics({ from: "2026-02-30" })).toThrow("UTC date"); expect(() => readAnalytics({ from: "2026-02-01", to: "2026-01-01" })).toThrow("Start date");
  } finally { env.cleanup(); }
});

test("incremental metrics wait for complete lines, shrink safely and exclude uncertain old fork history", () => {
  const env = tmpEnv();
  try {
    const f = createSession({ id: "partial", cwd: env.root }), start = readFileSync(f.transcriptPath, "utf8");
    const line = JSON.stringify({ type: "analytics_metric", timestamp: "2026-01-03T00:00:00Z", metric: { kind: "usage", model: "first", purpose: "answer", usage: usage(11) } });
    appendFileSync(f.transcriptPath, line); expect(readAnalytics().totals.tokens).toBe(0); appendFileSync(f.transcriptPath, "\n"); expect(readAnalytics().totals.tokens).toBe(11);
    writeFileSync(f.transcriptPath, start); expect(readAnalytics().totals.tokens).toBe(0);
    const old = createSession({ id: "old-fork", cwd: env.root, extra: { parent: "partial" } }); updateSessionSettings(old, { tokenUsage: usage(500) });
    record(old.transcriptPath, { kind: "tool", id: "copied", name: "Read", status: "started", source: "native" });
    expect(readAnalytics().totals.tools).toBe(0); expect(readAnalytics().coverage.legacyForks).toBe(1);
    record(old.transcriptPath, { kind: "usage", model: "new", purpose: "answer", usage: usage(13) }, "2026-01-04T00:00:00Z");
    record(old.transcriptPath, { kind: "tool", id: "new", name: "Read", status: "failure", source: "native" }, "2026-01-04T00:00:01Z");
    expect(readAnalytics().totals).toMatchObject({ tokens: 13, tools: 1, failures: 1 });
    rmSync(f.transcriptPath); const db = openSessionIndex(); refreshIndex(db); expect(db.query("SELECT * FROM session_analytics WHERE session_id='partial'").all()).toEqual([]); db.close();
  } finally { env.cleanup(); }
});

test("the actual Session persists answer, router, title, warmup and compaction accounting plus timed turn completion", async () => {
  const env = tmpEnv(), file = createSession({ id: "live-loop", cwd: env.root }), noTitle = process.env.RIGWELL_NO_AUTO_TITLE; let fixture: ReturnType<typeof makeStubSession> | undefined;
  try {
    delete process.env.RIGWELL_NO_AUTO_TITLE;
    fixture = makeStubSession((req) => req.sessionId === "router" ? text('{"scores":{"first":0.9,"other":0.1}}') : text("A sufficiently concrete response."), {
      id: file.id, cwd: env.root, autoTitle: true, autoRejectPermissionRequests: false,
      settings: { modelId: "auto", interactionMode: "auto", autonomyLevel: "high", reasoningEffort: "off", compactionModelId: "first" },
      router: { classifierModel: "classifier", candidates: [{ model: "first", description: "first", inputCost: 1 }, { model: "other", description: "other", inputCost: 2 }] },
      resolveModel: (id) => ({ id, model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: "http://127.0.0.1:1", maxContextLimit: 200000 }),
      persistence: { appendMessage: async (m, p) => { await appendMessage(file, m, p); }, appendTurnOutcome: (o) => appendTurnOutcome(file, o), appendAnalyticsMetric: (m) => appendAnalyticsMetric(file, m), saveSettings: async (s) => { updateSessionSettings(file, s); } },
    }, { requestPermission: async () => ({ selectedOption: "approve" }) });
    fixture.session.addUserMessage("Inspect this local fixture and explain the smallest change."); await fixture.session.settled();
    await fixture.session.warmupCache();
    await fixture.session.compactManual({ mode: "handoff" });
    const records = readFileSync(file.transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)), purposes = records.filter((r) => r.type === "analytics_metric" && r.metric.kind === "usage").map((r) => r.metric.purpose);
    expect(purposes).toContain("router"); expect(purposes).toContain("answer"); expect(purposes).toContain("title"); expect(purposes).toContain("warmup"); expect(purposes).toContain("compaction");
    expect(readAnalytics().totals.turns).toBe(1); expect(readAnalytics().totals.requests).toBe(purposes.length); expect(loadTranscript(file).unknownRecords).toBe(0);
  } finally { await fixture?.session.end(); if (fixture) rmSync(fixture.cwd, { recursive: true, force: true }); if (noTitle === undefined) delete process.env.RIGWELL_NO_AUTO_TITLE; else process.env.RIGWELL_NO_AUTO_TITLE = noTitle; env.cleanup(); }
});

test("retained automation attempts and mission worker outcomes have explicit denominators and no read-side installation", () => {
  const env = tmpEnv();
  try {
    const dir = join(env.rigwellHome, "automations", "example"), now = Date.now();
    writeJson(join(dir, "memory/state.json"), { id: "auto" }); writeJson(join(dir, "memory/runs.json"), ["success", "failure", "cancelled", "in_progress"].map((status, i) => ({ runId: String(i), status, startedAt: now, attempt: 1 })));
    const missing = join(env.rigwellHome, "automations", "not-initialized"); mkdirSync(missing); writeFileSync(join(missing, "HEARTBEAT.md"), "inert");
    const mission = new MissionStore(join(missionsRoot(), "lead")); mission.writeState({ state: "completed", workingDirectory: env.root });
    mission.log("worker_completed", { workerSessionId: "one", successState: "success" }); mission.log("worker_completed", { workerSessionId: "two", successState: "partial" }); mission.log("worker_failed", { workerSessionId: "three" }); mission.log("worker_failed", { workerSessionId: "three" }); mission.log("worker_paused", { workerSessionId: "four" });
    expect(readAnalytics().rates).toEqual({ automation: { success: 1, failure: 1, cancelled: 1, inProgress: 1, rate: .5 }, mission: { completed: 1, other: 0, workerSuccess: 1, workerPartial: 1, workerFailure: 1, workerRate: 1 / 3 } });
    expect(readAnalytics({ model: "first" }).rates.automation.rate).toBeNull(); expect(readAnalytics({ project: env.root }).rates.mission.completed).toBe(1); expect(existsSync(join(missing, "memory"))).toBe(false);
  } finally { env.cleanup(); }
});

test("CSV save confirms a local path, preserves CSV quoting and prevents formulas even from a tampered renderer", async () => {
  const env = tmpEnv(), file = join(env.root, "analytics.csv");
  try {
    const csv = csvRows([["section", "group", ...CSV_KEYS], ["usage", "project", "=malicious,\"quoted\"\nname", 3]]);
    expect(csv).toContain("'=malicious"); expect(sanitizeAnalyticsCsv(csv)).toBe(csv); expect(await saveAnalyticsExport(csv, async () => null)).toBeNull(); expect(existsSync(file)).toBe(false);
    const tampered = csv.replace("'=malicious", "=malicious"); expect(await saveAnalyticsExport(tampered, async () => file)).toBe(file); expect(readFileSync(file, "utf8")).toBe(csv);
    let rejected = false; try { await saveAnalyticsExport('"section","group","key",bad', async () => { throw new Error("must validate before dialog"); }); } catch (e) { rejected = String(e).includes("CSV"); } expect(rejected).toBe(true);
  } finally { env.cleanup(); }
});
