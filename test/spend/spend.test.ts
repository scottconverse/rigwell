import { expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { parseSpendLimits } from "../../src/spend/config.ts";
import { assertSpend, readSpendStatus, spendWarnings } from "../../src/spend/spend.ts";
import { createSession } from "../../src/storage/transcript.ts";
import { updateUserSettings } from "../../desktop/main/user-settings.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { judgeOutput } from "../../src/eval/judge.ts";
import { readAnalytics } from "../../src/analytics/analytics.ts";
import { makeStubSession, text, MODEL } from "../agent/helpers.ts";

const price = { inputPerMtok: 1, outputPerMtok: 2, cachedInputPerMtok: .1 };
function record(path: string, model: string, tokens: number, timestamp: string) { appendFileSync(path, JSON.stringify({ type: "analytics_metric", timestamp, metric: { kind: "usage", model, purpose: "answer", usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 } } }) + "\n"); }

test("cap validation preserves zero, rejects malformed controls and checks the actual settings write boundary", () => {
  const env = tmpEnv();
  try {
    expect(parseSpendLimits({ dailyUsd: 0, warnAt: .8, models: { fixture: { monthlyUsd: 2 } } })).toMatchObject({ dailyUsd: 0, models: { fixture: { monthlyUsd: 2 } } });
    for (const v of [{ dailyUsd: -1 }, { monthlyUsd: Infinity }, { warnAt: 0 }, { warnAt: 1.1 }, { dailyUsd: "3" }, { models: [] }, { models: { fixture: { typo: 1 } } }, { typo: 1 }]) expect(() => parseSpendLimits(v)).toThrow();
    updateUserSettings(env.rigwellHome, { spendLimits: { dailyUsd: 1 } }); const before = readFileSync(join(env.rigwellHome, "settings.json"), "utf8");
    expect(() => updateUserSettings(env.rigwellHome, { spendLimits: { dailyUsd: -1 } })).toThrow(); expect(readFileSync(join(env.rigwellHome, "settings.json"), "utf8")).toBe(before);
  } finally { env.cleanup(); }
});

test("UTC daily/monthly caps and warnings use dated own accounting with separate model and unknown coverage", () => {
  const env = tmpEnv();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { analytics: { prices: { first: price, second: price } } });
    const file = createSession({ id: "spend-history", cwd: env.root });
    record(file.transcriptPath, "first", 9_000_000, "2026-01-31T23:59:59Z"); record(file.transcriptPath, "first", 1_000_000, "2026-02-01T00:00:00Z"); record(file.transcriptPath, "first", 2_000_000, "2026-02-02T12:00:00Z"); record(file.transcriptPath, "second", 1_000_000, "2026-02-02T15:00:00Z");
    const config = { dailyUsd: 4, monthlyUsd: 5, warnAt: .75, models: { first: { dailyUsd: 2, monthlyUsd: 4 } } };
    const status = readSpendStatus(new Date("2026-02-02T23:59:59Z"), config);
    expect(status.rows).toEqual([{ period: "day", capUsd: 4, spentUsd: 3, remainingUsd: 1, status: "warning" }, { model: "first", period: "day", capUsd: 2, spentUsd: 2, remainingUsd: 0, status: "blocked" }, { period: "month", capUsd: 5, spentUsd: 4, remainingUsd: 1, status: "warning" }, { model: "first", period: "month", capUsd: 4, spentUsd: 3, remainingUsd: 1, status: "warning" }]);
    expect(spendWarnings(status, "second")).toHaveLength(2); expect(readSpendStatus(new Date("2026-03-01T00:00:00Z"), config).rows.every((r) => r.spentUsd === 0 && r.status === "ok")).toBe(true);
    record(file.transcriptPath, "unknown-price", 1, "2026-02-02T16:00:00Z"); const unknown = readSpendStatus(new Date("2026-02-02T23:59:59Z"), config); expect(unknown.rows[0]).toMatchObject({ spentUsd: null, status: "unknown", remainingUsd: null });
    expect(readSpendStatus(new Date("2026-02-02T23:59:59Z"), config).rows).toEqual(unknown.rows);
  } finally { env.cleanup(); }
});

test("actual Session stops new turns and auxiliary calls at a cap, preserves the completed answer and can use an uncapped profile", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "First completed answer" }, { text: "Other profile answer" }]), notes: any[] = [];
  const member = new MemberSession({ notify: (n) => notes.push(n), request: async () => ({ selectedOption: "cancel" }), tools: (t) => t });
  try {
    const settings = { customModels: ["First", "Other"].map((displayName) => ({ displayName, model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" })), analytics: { prices: { "custom:First-0": price, "custom:Other-1": price } }, spendLimits: { models: { "custom:First-0": { dailyUsd: .000001 } } } };
    writeJson(join(env.rigwellHome, "settings.json"), settings);
    await member.call("initialize_session", { cwd: env.root, modelId: "custom:First-0", autonomyLevel: "low" }); await member.call("add_user_message", { text: "Answer once" }); await member.connection.session!.idle();
    expect(fake.requests).toHaveLength(1); expect(member.connection.session!.uiMessages().some((m) => JSON.stringify(m.content).includes("First completed answer"))).toBe(true); expect(notes.some((n) => n.type === "create_message" && JSON.stringify(n.message).includes("spend blocked"))).toBe(true);
    await member.call("add_user_message", { text: "Must not call again" }); await member.connection.session!.idle(); expect(fake.requests).toHaveLength(1); expect(notes.some((n) => n.type === "error" && n.message.includes("cap reached"))).toBe(true);
    await member.connection.session!.warmupCache(); expect(fake.requests).toHaveLength(1);
    await member.call("update_session_settings", { modelId: "custom:Other-1" }); await member.call("add_user_message", { text: "Use the uncapped profile" }); await member.connection.session!.idle(); expect(fake.requests).toHaveLength(2);
    updateUserSettings(env.rigwellHome, { spendLimits: { dailyUsd: 0 } }); expect(() => assertSpend("custom:Other-1")).toThrow("cap reached");
    updateUserSettings(env.rigwellHome, { spendLimits: { monthlyUsd: 10 }, analytics: { prices: {} } }); expect(() => assertSpend("custom:Other-1")).toThrow("cannot be priced");
  } finally { await member.close(); fake.stop(); env.cleanup(); }
});

test("a capped unpriced request is refused before HTTP and completed judges enter shared accounting", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: '{"score":1,"reason":"Fixture passed"}' }]);
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ displayName: "Judge", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }], spendLimits: { monthlyUsd: 1 } });
    expect(() => assertSpend("custom:Judge-0")).toThrow("explicit analytics.prices");
    const input = { model: "custom:Judge-0", rubric: "Correct", prompt: "Fixture", output: "Answer", diff: "", cwd: env.root };
    expect((await judgeOutput(input)).status).toBe("error"); expect(fake.requests).toHaveLength(0);
    updateUserSettings(env.rigwellHome, { analytics: { prices: { "custom:Judge-0": price } } }); expect((await judgeOutput(input)).score).toBe(1); expect(fake.requests).toHaveLength(1); expect(readAnalytics().totals.requests).toBe(1);
    updateUserSettings(env.rigwellHome, { spendLimits: { monthlyUsd: 0 } }); expect((await judgeOutput(input)).status).toBe("error"); expect(fake.requests).toHaveLength(1);
  } finally { fake.stop(); env.cleanup(); }
});

test("a child engine warns once at the threshold and rechecks the cap before later admission", async () => {
  const env = tmpEnv();
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { analytics: { prices: { [MODEL.id]: price } }, spendLimits: { dailyUsd: 1, warnAt: .8 } });
    const files = createSession({ id: "spend-child", cwd: env.root });
    record(files.transcriptPath, MODEL.id, 800_000, new Date().toISOString());
    const { session, requests, stored, notes } = makeStubSession(() => text("Child answer"), { isChild: true });
    session.addUserMessage("First child request"); await session.settled();
    session.addUserMessage("Second child request"); await session.settled();
    expect(requests).toHaveLength(2);
    expect(stored.filter((m) => m.visibility === "user_only" && JSON.stringify(m.content).includes("spend warning"))).toHaveLength(1);
    expect(requests.every((r) => !JSON.stringify(r.messages).includes("spend warning"))).toBe(true);
    record(files.transcriptPath, MODEL.id, 200_000, new Date().toISOString());
    session.addUserMessage("Blocked child request"); await session.settled();
    expect(requests).toHaveLength(2); expect(notes.some((n) => n.type === "error" && n.message.includes("cap reached"))).toBe(true);
  } finally { env.cleanup(); }
});
