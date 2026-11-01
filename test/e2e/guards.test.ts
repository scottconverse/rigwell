// Phase 4 done-when: fault-injection tests. Each loop guard hits the action spec 4.2 defines.
// In-process connection (the real protocol methods) against the fake Anthropic server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession } from "../../src/storage/transcript.ts";
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

const MODEL = "custom:Fake-Anthropic-0";

async function setup(script: FakeTurn[], settings: Record<string, unknown> = {}, init: Record<string, unknown> = {}) {
  const server = await startFakeAnthropic(script);
  servers.push(server);
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rigwell-guards-home-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    customModels: [{ model: "fake-anthropic", displayName: "Fake Anthropic", provider: "anthropic", baseUrl: server.url, apiKey: "test-key-not-real" }],
    ...settings,
  }));
  process.env.RIGWELL_HOME = home;
  const c = inproc();
  const r = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: MODEL, toolExecutionMode: "direct_only", autonomyLevel: "low", ...init });
  return { server, repo, home, c, sessionId: r.sessionId as string };
}

const completed = (c: ReturnType<typeof inproc>) => c.notes().filter((n) => n.type === "agent_turn_completed").at(-1);
const read: FakeTurn = () => ({ toolCalls: [{ name: "Read", input: { path: "greet.js" } }] });
const lastUser = (body: any) => JSON.stringify(body.messages.at(-1));

describe("silent stream", () => {
  test("no bytes past the idle limit: treated as dropped, retried as a timeout, then succeeds", async () => {
    const s = await setup([{ hang: true }, { text: "recovered after the silence" }], { loopGuards: { streamIdleTimeoutMs: 300 } });
    const t0 = Date.now();
    await s.c.turn("hello");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(2);
    const retry = s.c.notes().filter((n) => n.type === "llm_retry");
    expect(retry.length).toBe(1);
    expect(retry[0].reason).toBe("timeout");
    expect(retry[0].attempt).toBe(1);
    const msgs = loadSession(s.sessionId, s.repo).messages.filter((m) => m.role === "assistant");
    expect(msgs.map((m) => m.content)).toEqual([[{ type: "text", text: "recovered after the silence" }]]);
  }, 20_000);

  test("the idle limit is vendor-hosted 240 s only for api.anthropic.com; custom models use llmRequestTimeout", async () => {
    const { resolveGuards, VENDOR_ANTHROPIC_IDLE_MS, DEFAULT_LLM_REQUEST_TIMEOUT_MS } = await import("../../src/agent/guards.ts");
    const hosted: any = { id: "a", model: "m", displayName: "a", provider: "anthropic", baseUrl: "https://api.anthropic.com" };
    const custom: any = { ...hosted, baseUrl: "http://127.0.0.1:9" };
    expect(resolveGuards({}, hosted).streamIdleTimeoutMs).toBe(VENDOR_ANTHROPIC_IDLE_MS);
    expect(resolveGuards({}, custom).streamIdleTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(resolveGuards({ llmRequestTimeout: 90_000 }, custom).streamIdleTimeoutMs).toBe(90_000);
    expect(resolveGuards({ llmRequestTimeout: 90_000 }, custom).hardResponseLimitMs).toBe(90_000);
    expect(resolveGuards({ loopGuards: { streamIdleTimeoutMs: 5 } }, hosted).streamIdleTimeoutMs).toBe(5);
  });
});

describe("hard response time limit", () => {
  test("a response that keeps sending bytes but never ends is cut; only the first cut is retried", async () => {
    const s = await setup([{ trickle: true }, { trickle: true }, { text: "never reached" }], { loopGuards: { streamIdleTimeoutMs: 5_000, hardResponseLimitMs: 400 } });
    await s.c.turn("hello");
    expect(s.server.requests.length).toBe(2);
    expect(s.c.notes().filter((n) => n.type === "llm_retry").map((n) => n.reason)).toEqual(["timeout"]);
    expect(completed(s.c).reason).toBe("model_provider_unreachable");
    expect(s.c.notes().some((n) => n.type === "error" && /time limit/.test(n.message))).toBe(true);
  }, 20_000);

  test("the server can set the limit for one response with a header", async () => {
    const s = await setup([{ trickle: true, headers: { "x-response-time-limit-ms": "250" } }, { text: "fine" }]); // default limit is 10 minutes
    const t0 = Date.now();
    await s.c.turn("hello");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s.c.notes().filter((n) => n.type === "llm_retry").map((n) => n.reason)).toEqual(["timeout"]);
    expect(completed(s.c).reason).toBe("completed");
  }, 20_000);

  test("a first cut that took longer than limit + 60 s is not retried (unit)", async () => {
    const { streamWithRetry } = await import("../../src/adapters/retry.ts");
    const { ModelError } = await import("../../src/core/types.ts");
    let calls = 0;
    const adapter = { stream: async function* () { calls++; throw new ModelError("timeout", "cut", { retryable: true, cause: "hard_limit", elapsedMs: 700_000, limitMs: 600_000 }); } };
    await expect((async () => { for await (const _ of streamWithRetry(adapter as any, { signal: undefined } as any, { strategy: "non_interactive", baseDelayMs: 1 })) { /* */ } })()).rejects.toThrow("cut");
    expect(calls).toBe(1);
    let calls2 = 0;
    const adapter2 = {
      stream: async function* () {
        calls2++;
        if (calls2 === 1) throw new ModelError("timeout", "cut", { retryable: true, cause: "hard_limit", elapsedMs: 630_000, limitMs: 600_000 });
        yield { type: "message_done", content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 } };
      },
    };
    const evs: any[] = [];
    for await (const e of streamWithRetry(adapter2 as any, { signal: undefined } as any, { strategy: "non_interactive", baseDelayMs: 1 })) evs.push(e);
    expect(calls2).toBe(2);
    expect(evs.at(-1).type).toBe("message_done");
  });
});

describe("partial stream", () => {
  test("a stream that breaks mid-message is discarded and retried; the transcript has only the complete message", async () => {
    const s = await setup([{ text: "PARTIAL ANSWER THAT NEVER FINISHES", breakMidStream: true }, { text: "The complete answer." }]);
    await s.c.turn("hello");
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(2);
    // the first attempt's deltas reached the client as display only, followed by llm_retry
    const notes = s.c.notes();
    const retryAt = notes.findIndex((n) => n.type === "llm_retry");
    expect(retryAt).toBeGreaterThan(-1);
    expect(notes[retryAt].reason).toBe("network");
    expect(notes.slice(0, retryAt).some((n) => n.type === "assistant_text_delta")).toBe(true);
    const stored = loadSession(s.sessionId, s.repo).messages.filter((m) => m.role === "assistant");
    expect(stored.length).toBe(1);
    expect(JSON.stringify(stored)).toContain("The complete answer.");
    expect(JSON.stringify(stored)).not.toContain("PARTIAL");
    expect(JSON.stringify(s.server.requests[1])).not.toContain("PARTIAL");
  }, 20_000);

  test("retries go to the same model, provider and URL", async () => {
    const s = await setup([{ status: 503 }, { status: 529 }, { text: "ok" }]);
    await s.c.turn("hello");
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(3);
    expect(new Set(s.server.requests.map((r) => r.model))).toEqual(new Set(["fake-anthropic"]));
    expect(JSON.stringify(s.server.requests[2])).toBe(JSON.stringify(s.server.requests[0]));
  }, 20_000);
});

describe("repeated identical tool calls", () => {
  test("nudge at 3 identical batches, stop at 6 with the reason; the transcript says why", async () => {
    const s = await setup(Array.from({ length: 10 }, () => read));
    await s.c.turn("keep reading");
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(6);
    const nudge = "with the same arguments 3 times in a row";
    expect(lastUser(s.server.requests[2])).not.toContain(nudge); // 3rd result is sent with the 4th request
    expect(lastUser(s.server.requests[3])).toContain(nudge);
    expect(lastUser(s.server.requests[3])).toContain("(Read)");
    expect(lastUser(s.server.requests[4])).not.toContain("5 times in a row");
    const stop = s.c.notes().find((n) => n.type === "create_message" && /repeated identical tool calls/.test(JSON.stringify(n.message)));
    expect(JSON.stringify(stop.message)).toContain("Stopped: repeated identical tool calls (Read, 6 times in a row).");
    const stored = loadSession(s.sessionId, s.repo).messages;
    const note = stored.at(-1)!;
    expect(note.visibility).toBe("llm_only");
    expect(JSON.stringify(note.content)).toContain("6 identical calls to Read with unchanged results");
  }, 30_000);

  test("identical calls that return new results (polling) are allowed", async () => {
    const poll: FakeTurn = () => ({ toolCalls: [{ name: "Execute", input: { command: "date +%s%N", riskLevel: "low", riskReason: "Prints the time." } }] });
    const s = await setup([...Array.from({ length: 9 }, () => poll), { text: "done polling" }]);
    await s.c.turn("poll");
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(10);
    expect(s.server.requests.some((r) => JSON.stringify(r).includes("times in a row, and the results have not changed"))).toBe(false);
  }, 30_000);

  test("thresholds are config values", async () => {
    const s = await setup(Array.from({ length: 10 }, () => read), { loopGuards: { repeatNudgeAt: 2, repeatStopAt: 3 } });
    await s.c.turn("keep reading");
    expect(s.server.requests.length).toBe(3);
    expect(lastUser(s.server.requests[2])).toContain("2 times in a row");
  }, 30_000);
});

describe("empty turns", () => {
  test("no visible output: one-word continue each time, stop at 3 in a row", async () => {
    // each empty answer is retried once first (spec 4.6.9), so every "empty turn" uses two scripted responses
    const s = await setup([{}, {}, { thinking: "hmm" }, { thinking: "hmm" }, {}, {}, { text: "unreachable" }]);
    await s.c.turn("say something");
    expect(completed(s.c).reason).toBe("completed");
    expect(s.server.requests.length).toBe(6);
    expect(s.c.notes().filter((n) => n.type === "llm_retry").map((n) => n.reason)).toEqual(["empty_response", "empty_response", "empty_response"]);
    const stored = loadSession(s.sessionId, s.repo).messages;
    const nudges = stored.filter((m) => m.role === "user" && m.visibility === "llm_only" && JSON.stringify(m.content) === '[{"type":"text","text":"continue"}]');
    expect(nudges.length).toBe(2);
    expect(JSON.stringify(s.server.requests[5].messages.at(-1))).toContain("continue");
    const stop = s.c.notes().find((n) => n.type === "create_message" && /no output/.test(JSON.stringify(n.message)));
    expect(JSON.stringify(stop.message)).toContain("Stopped: the model returned no output 3 times in a row.");
    expect(JSON.stringify(stored.at(-1)!.content)).toContain("3 responses in a row with no output");
  }, 30_000);

  test("a visible answer resets the count", async () => {
    const s = await setup([{}, {}, { text: "now I answer" }]);
    await s.c.turn("hi");
    expect(s.server.requests.length).toBe(3);
    expect(completed(s.c).reason).toBe("completed");
    expect(JSON.stringify(s.server.requests[2].messages.at(-1))).toContain("continue");
  });
});

describe("output cycle", () => {
  test("the same text repeating is cut and reported with its length and repeat count", async () => {
    const s = await setup([{ text: "The quick brown fox jumps. ".repeat(300) }, { text: "second try" }]);
    await s.c.turn("go");
    expect(completed(s.c).reason).toBe("error");
    const err = s.c.notes().find((n) => n.type === "error");
    expect(err.message).toMatch(/the same 27-character block repeated \d+ times/);
    const stored = loadSession(s.sessionId, s.repo).messages;
    expect(stored.some((m) => m.role === "assistant")).toBe(false);
    expect(JSON.stringify(stored.at(-1)!.content)).toContain("cut by the harness");
  }, 20_000);

  test("detectCycle: ordinary prose is not a cycle; a repeated line is", async () => {
    const { detectCycle } = await import("../../src/agent/guards.ts");
    const prose = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} says something different about item ${i * 7}.`).join(" ");
    expect(detectCycle(prose, 1200, 8)).toBeNull();
    expect(detectCycle("abc ".repeat(400), 1200, 8)).toEqual({ length: 4, repeats: 300 });
  });
});
