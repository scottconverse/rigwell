// Phase 4: automatic model routing (spec 4.5) with fake servers. The classifier is a fake returning JSON scores.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifierInput, parseScores, pickRoute, type RouterConfig } from "../../src/agent/router.ts";
import { findSession, loadTranscript } from "../../src/storage/transcript.ts";
import { readSessionSettings } from "../../src/storage/session-settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { inproc } from "./inproc.ts";
import { makeRepo } from "./helpers.ts";

const servers: FakeServer[] = [];
const prevHome = process.env.RIGWELL_HOME;
afterAll(() => {
  servers.forEach((s) => s.stop());
  if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
});

const cfg: RouterConfig = {
  classifierModel: "custom:Classifier-0",
  candidates: [
    { model: "custom:Cheap-1", description: "small and fast", inputCost: 1 },
    { model: "custom:Mid-2", description: "balanced", inputCost: 3 },
    { model: "custom:Strong-3", description: "best at hard problems", inputCost: 10 },
  ],
};

describe("router rules", () => {
  test("cheapest candidate at or above 0.7 wins; ties go to the higher score; others become fallbacks ordered by score", () => {
    const c = pickRoute(cfg, { "custom:Cheap-1": 0.4, "custom:Mid-2": 0.8, "custom:Strong-3": 0.95 });
    expect(c.modelId).toBe("custom:Mid-2");
    expect(c.fallbacks).toEqual(["custom:Strong-3", "custom:Cheap-1"]);
    expect(c.reason).toBe("task_fit");
    const tie = pickRoute({ ...cfg, candidates: cfg.candidates.map((x) => ({ ...x, inputCost: 1 })) }, { "custom:Cheap-1": 0.75, "custom:Mid-2": 0.9, "custom:Strong-3": 0.72 });
    expect(tie.modelId).toBe("custom:Mid-2");
    expect(tie.reason).toBe("routine"); // all three qualify (at least 75 percent)
  });
  test("none reaches the bar: the highest score; all zero: the first candidate; one candidate: policy", () => {
    const hard = pickRoute(cfg, { "custom:Cheap-1": 0.2, "custom:Mid-2": 0.5, "custom:Strong-3": 0.6 });
    expect(hard.modelId).toBe("custom:Strong-3");
    expect(hard.reason).toBe("hard");
    expect(pickRoute(cfg, {}).modelId).toBe("custom:Cheap-1");
    expect(pickRoute({ ...cfg, candidates: [cfg.candidates[1]!] }, {}).reason).toBe("policy");
    expect(pickRoute({ ...cfg, threshold: 0.99 }, { "custom:Cheap-1": 0.9, "custom:Mid-2": 0.9, "custom:Strong-3": 0.95 }).modelId).toBe("custom:Strong-3");
  });
  test("malformed classifier JSON is recovered where possible", () => {
    const ids = cfg.candidates.map((x) => x.model);
    expect(parseScores('Here you go:\n```json\n{"scores":{"custom:Cheap-1":{"score":0.1,"label":"x","reason":"y"},"custom:Mid-2":{"score":0.9}}}\n```', ids))
      .toEqual({ "custom:Cheap-1": 0.1, "custom:Mid-2": 0.9 });
    expect(parseScores('{"custom:Cheap-1": 0.3, "custom:Strong-3": 1.4,}', ids)).toEqual({ "custom:Cheap-1": 0.3, "custom:Strong-3": 1 });
    expect(parseScores("custom:Mid-2: 0.85 and custom:Cheap-1 = 0.2", ids)).toEqual({ "custom:Mid-2": 0.85, "custom:Cheap-1": 0.2 });
    expect(parseScores("no scores here", ids)).toEqual({});
  });
  test("classifier input: current request first, last 6 messages and 8 tool calls, long text cut to its ends, within budget", () => {
    const msgs: any[] = [{ id: "t1", role: "user", content: [{ type: "text", text: "Fix the build " + "x".repeat(10_000) }] }];
    for (let i = 0; i < 12; i++) {
      msgs.push({ id: `a${i}`, role: "assistant", content: [{ type: "tool_use", id: `u${i}`, name: "Read", input: { path: `f${i}.ts` } }] });
      msgs.push({ id: `r${i}`, role: "user", content: [{ type: "tool_result", tool_use_id: `u${i}`, content: "y".repeat(500) }] });
    }
    const input = classifierInput(msgs);
    expect(input.startsWith("## Current request")).toBe(true);
    expect(input).toContain("[... cut ...]");
    expect(input).toContain("f11.ts");
    expect(input).not.toContain("f3.ts"); // only the last 8 tool calls
    expect(input.length / 4).toBeLessThan(16_000);
  });
});

async function setup(servers_: { classifier: FakeTurn[]; cheap?: FakeTurn[]; mid?: FakeTurn[]; strong?: FakeTurn[] }) {
  const mk = async (script: FakeTurn[]) => { const s = await startFakeAnthropic(script); servers.push(s); return s; };
  const classifier = await mk(servers_.classifier);
  const cheap = await mk(servers_.cheap ?? []);
  const mid = await mk(servers_.mid ?? []);
  const strong = await mk(servers_.strong ?? []);
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rigwell-router-home-"));
  const model = (name: string, url: string) => ({ model: `fake-${name.toLowerCase()}`, displayName: name, provider: "anthropic", baseUrl: url, apiKey: "test-key-not-real" });
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    customModels: [model("Classifier", classifier.url), model("Cheap", cheap.url), model("Mid", mid.url), model("Strong", strong.url)],
    autoRouter: cfg,
  }));
  process.env.RIGWELL_HOME = home;
  const c = inproc();
  const r = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: "auto", toolExecutionMode: "direct_only", autonomyLevel: "low" });
  return { classifier, cheap, mid, strong, repo, c, sessionId: r.sessionId as string };
}

const scores = (a: number, b: number, c: number): FakeTurn => () => ({
  text: JSON.stringify({ scores: { "custom:Cheap-1": { score: a, label: "l", reason: "r" }, "custom:Mid-2": { score: b, label: "l", reason: "r" }, "custom:Strong-3": { score: c, label: "l", reason: "r" } } }),
});

describe("auto model", () => {
  test("the classifier runs per request; the cheapest qualifying model answers; effectiveRouterModel is recorded", async () => {
    const s = await setup({
      classifier: [scores(0.3, 0.8, 0.95), scores(0.3, 0.8, 0.95)],
      mid: [() => ({ toolCalls: [{ name: "Read", input: { path: "greet.js" } }] }), { text: "Fixed with the mid model." }],
    });
    await s.c.turn("rename a variable");
    expect(s.c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("completed");
    expect(s.classifier.requests.length).toBe(2); // once per request
    expect(s.mid.requests.length).toBe(2);
    expect(s.cheap.requests.length + s.strong.requests.length).toBe(0);
    // classifier request shape: its own system block, no tools, JSON out
    const cr = s.classifier.requests[0];
    expect(cr.tools).toBeUndefined();
    expect(cr.max_tokens).toBe(8192);
    expect(JSON.stringify(cr.messages)).toContain("rename a variable");
    expect(JSON.stringify(cr.messages)).toContain("custom:Strong-3: best at hard problems");
    const st = readSessionSettings(findSession(s.sessionId, s.repo)!)!;
    expect(st.model).toBe("auto");
    expect(st.effectiveRouterModel).toEqual({
      modelId: "custom:Mid-2", reasoningEffort: "high", reason: "task_fit",
      fallbacks: [{ modelId: "custom:Strong-3", reasoningEffort: "high" }, { modelId: "custom:Cheap-1", reasoningEffort: "high" }],
    });
    const asst = loadTranscript(findSession(s.sessionId, s.repo)!).messages.filter((m) => m.role === "assistant");
    expect(asst.every((m) => m.modelId === "custom:Mid-2")).toBe(true);
  }, 30_000);

  test("when the chosen model's provider keeps failing, the next candidate by score answers", async () => {
    const s = await setup({
      classifier: [scores(0.3, 0.8, 0.95)],
      mid: Array.from({ length: 6 }, () => ({ status: 503 })),
      strong: [{ text: "Strong model here." }],
    });
    await s.c.turn("hard thing");
    expect(s.c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("completed");
    expect(s.mid.requests.length).toBe(5); // all retries on the same provider first
    expect(s.strong.requests.length).toBe(1);
    expect(s.cheap.requests.length).toBe(0);
    const asst = loadTranscript(findSession(s.sessionId, s.repo)!).messages.filter((m) => m.role === "assistant");
    expect(asst[0]!.modelId).toBe("custom:Strong-3");
  }, 30_000);

  test("a broken classifier falls back to the first candidate; the routed model is cleared after compaction", async () => {
    const s = await setup({
      classifier: [{ status: 500 }, { text: "not json at all" }, scores(0.1, 0.1, 0.9)],
      cheap: [{ text: "cheap answer one" }, { text: "cheap answer two" }, { text: "## 1. User requests\nSummary." }],
      strong: [{ text: "strong answer" }],
    });
    await s.c.turn("first");
    expect(s.cheap.requests.length).toBe(1);
    expect((readSessionSettings(findSession(s.sessionId, s.repo)!)!.effectiveRouterModel as any).reason).toBe("fallback");
    await s.c.turn("second");
    expect(s.cheap.requests.length).toBe(2);
    await s.c.call("compact_session", {}); // summarizer runs on the routed model (cheap)
    expect(s.cheap.requests.length).toBe(3);
    expect(readSessionSettings(findSession(s.sessionId, s.repo)!)!.effectiveRouterModel).toBeUndefined();
    await s.c.turn("third");
    expect(s.strong.requests.length).toBe(1); // routing ran again and now picks the strong model
  }, 30_000);

  test("auto without a configured router is rejected", async () => {
    const server = await startFakeAnthropic([]);
    servers.push(server);
    const home = mkdtempSync(join(tmpdir(), "rigwell-router-home-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ customModels: [{ model: "m", displayName: "M", provider: "anthropic", baseUrl: server.url, apiKey: "test-key-not-real" }] }));
    process.env.RIGWELL_HOME = home;
    const c = inproc();
    await expect(c.call("initialize_session", { machineId: "default", cwd: makeRepo(), modelId: "auto" })).rejects.toThrow(/Unknown model/);
  });
});
