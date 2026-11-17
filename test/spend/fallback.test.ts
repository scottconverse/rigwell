import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { parseFallbackModels } from "../../src/agent/fallback-config.ts";
import { updateUserSettings } from "../../desktop/main/user-settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { inproc } from "../e2e/inproc.ts";
import { loadTranscript, findSession, createSession, appendAnalyticsMetric } from "../../src/storage/transcript.ts";
import { readAnalytics } from "../../src/analytics/analytics.ts";
import { makeStubSession, MODEL } from "../agent/helpers.ts";
import { ModelError } from "../../src/core/types.ts";

const ids = ["custom:Primary-0", "custom:Limited-1", "custom:Backup-2"];
const price = { inputPerMtok: 1, outputPerMtok: 2, cachedInputPerMtok: .1 };

test("fallback settings preserve order, deduplicate and reject malformed lists before writing", () => {
  const env = tmpEnv(); try {
    expect(parseFallbackModels(["a", "b", "a"])).toEqual(["a", "b"]); expect(parseFallbackModels(null)).toEqual([]);
    updateUserSettings(env.rigwellHome, { fallbackModels: ["a"] }); const before = readFileSync(join(env.rigwellHome, "settings.json"), "utf8");
    for (const value of ["a", ["auto"], [""], [" a"], [1], new Array(33).fill("a")]) expect(() => updateUserSettings(env.rigwellHome, { fallbackModels: value })).toThrow();
    expect(readFileSync(join(env.rigwellHome, "settings.json"), "utf8")).toBe(before);
  } finally { env.cleanup(); }
});

test("real protocol exhausts error/rate retries in order, uses fallback tools and attributes only the completed request", async () => {
  const env = tmpEnv(), primary = await startFakeAnthropic(new Array(10).fill({ status: 503 })), limited = await startFakeAnthropic(new Array(10).fill({ status: 429 }));
  const backup = await startFakeAnthropic([{ toolCalls: [{ name: "Script", input: { script: "print('fallback tool ran');" } }] }, { text: "Backup completed" }]); const c = inproc();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { autoSessionTitle: false, customModels: [primary, limited, backup].map((server, i) => ({ displayName: ["Primary", "Limited", "Backup"][i], model: "fixture", provider: "anthropic", baseUrl: server.url, apiKey: "fake-only" })), fallbackModels: [ids[0], "missing-profile", ids[1], ids[2], ids[2]], modelProfiles: { [ids[2]!]: { toolExecutionMode: "script_only" } } });
    const init = await c.call("initialize_session", { cwd: env.root, modelId: ids[0], autonomyLevel: "high" }); await c.turn("Use the configured pool");
    expect(c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("completed"); expect(primary.requests).toHaveLength(10); expect(limited.requests).toHaveLength(10); expect(backup.requests).toHaveLength(2);
    expect(backup.requests.every((r) => r.tools.some((t: any) => t.name === "Script") && !r.tools.some((t: any) => t.name === "Read"))).toBe(true);
    expect(JSON.stringify(backup.requests[1].messages)).toContain("fallback tool ran");
    const messages = loadTranscript(findSession(init.sessionId, env.root)!).messages, answers = messages.filter((m) => m.role === "assistant" && m.visibility !== "user_only");
    expect(answers.every((m) => m.modelId === ids[2])).toBe(true); expect(messages.filter((m) => m.visibility === "user_only" && JSON.stringify(m.content).includes("configured fallback"))).toHaveLength(4);
    expect(backup.requests.every((r) => !JSON.stringify(r.messages).includes("trying configured fallback"))).toBe(true);
    expect(c.conn.session!.settings.modelId).toBe(ids[0]); expect(c.conn.session!.settingsSnapshot().effectiveFallbackModel).toBe(ids[2]); expect(readAnalytics().totals.requests).toBe(2);
  } finally { await c.conn.shutdown(); primary.stop(); limited.stop(); backup.stop(); env.cleanup(); }
});

test("per-model caps fall through without HTTP, overall caps stop the pool, and compaction can use a fallback", async () => {
  const env = tmpEnv(), primary = await startFakeAnthropic([]), backup = await startFakeAnthropic([{ text: "Fallback answer" }, { text: "Summary of the fixture" }]), c = inproc();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { autoSessionTitle: false, customModels: [primary, backup].map((server, i) => ({ displayName: i ? "Backup" : "Primary", model: "fixture", provider: "anthropic", baseUrl: server.url, apiKey: "fake-only" })), fallbackModels: ["custom:Backup-1"], spendLimits: { models: { [ids[0]!]: { dailyUsd: 0 } } }, analytics: { prices: { [ids[0]!]: price, "custom:Backup-1": price } } });
    await c.call("initialize_session", { cwd: env.root, modelId: ids[0], compactionModelId: ids[0] }); await c.turn("A capped primary should use the configured alternative");
    expect(primary.requests).toHaveLength(0); expect(backup.requests).toHaveLength(1);
    await c.call("compact_session", { mode: "handoff" }); expect(backup.requests).toHaveLength(2); expect(primary.requests).toHaveLength(0);
    updateUserSettings(env.rigwellHome, { spendLimits: { dailyUsd: 0 } }); await c.turn("Overall cap must not fall through"); expect(backup.requests).toHaveLength(2); expect(c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("error");
  } finally { await c.conn.shutdown(); primary.stop(); backup.stop(); env.cleanup(); }
});

test("cancelled requests and ordinary tool errors never select another profile", async () => {
  const env = tmpEnv(); try {
    const alternate = { ...MODEL, id: "alternate" }, adapters: string[] = [];
    const { session, requests } = makeStubSession(() => { session.interrupt(); throw new ModelError("network", "Interrupted fixture"); }, { fallbackModels: [alternate.id], resolveModel: (id) => id === alternate.id ? alternate : MODEL, createAdapter: (m) => { adapters.push(m.id); return {} as any; } });
    session.addUserMessage("Cancel"); await session.settled(); expect(requests).toHaveLength(1); expect(adapters).toEqual([MODEL.id]); expect(session.lastTurn?.reason).toBe("cancelled");
    const ordinary = makeStubSession(() => { throw new Error("not a provider failure"); }, { fallbackModels: [alternate.id], resolveModel: (id) => id === alternate.id ? alternate : MODEL });
    ordinary.session.addUserMessage("Fail"); await ordinary.session.settled(); expect(ordinary.requests).toHaveLength(1);
  } finally { env.cleanup(); }
});

test("policy-blocked profiles are skipped and repository configuration cannot replace the owner's pool", async () => {
  const env = tmpEnv(), primary = await startFakeAnthropic([{ status: 401 }]), blocked = await startFakeAnthropic([]), backup = await startFakeAnthropic([{ text: "Allowed fallback" }]), c = inproc();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { autoSessionTitle: false, customModels: [primary, blocked, backup].map((server, i) => ({ displayName: ["Primary", "Limited", "Backup"][i], model: ["primary", "blocked", "backup"][i], provider: "anthropic", baseUrl: server.url, apiKey: "fake-only" })), fallbackModels: [ids[1], ids[2]] });
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, modelPolicy: { blockedModelIds: ["blocked"] } });
    writeJson(join(env.root, ".rigwell/settings.json"), { fallbackModels: [] });
    await c.call("initialize_session", { cwd: env.root, modelId: ids[0] }); await c.turn("Respect policy and owner configuration");
    expect(primary.requests).toHaveLength(1); expect(blocked.requests).toHaveLength(0); expect(backup.requests).toHaveLength(1); expect(c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("completed");
  } finally { await c.conn.shutdown(); primary.stop(); blocked.stop(); backup.stop(); env.cleanup(); }
});

test("an unpriced prospective profile can fall through but unpriced overall history cannot", async () => {
  const env = tmpEnv(), primary = await startFakeAnthropic([]), backup = await startFakeAnthropic([{ text: "Priced fallback" }]), c = inproc();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { autoSessionTitle: false, customModels: [primary, backup].map((server, i) => ({ model: "fixture", displayName: i ? "Backup" : "Primary", provider: "anthropic", baseUrl: server.url, apiKey: "fake-only" })), fallbackModels: ["custom:Backup-1"], spendLimits: { dailyUsd: 1 }, analytics: { prices: { "custom:Backup-1": price } } });
    await c.call("initialize_session", { cwd: env.root, modelId: ids[0] }); await c.turn("Use only a priced profile"); expect(primary.requests).toHaveLength(0); expect(backup.requests).toHaveLength(1); expect(c.conn.session!.lastTurn?.reason).toBe("completed");
    await appendAnalyticsMetric(createSession({ id: "unpriced-history", cwd: env.root }), { kind: "usage", model: "missing-price", purpose: "answer", usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } });
    await c.turn("Unknown overall spending must block every candidate"); expect(primary.requests).toHaveLength(0); expect(backup.requests).toHaveLength(1); expect(c.conn.session!.lastTurn?.reason).toBe("error");
  } finally { await c.conn.shutdown(); primary.stop(); backup.stop(); env.cleanup(); }
});
