import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai.ts";
import { streamWithRetry } from "../../src/adapters/retry.ts";
import { ModelError, type Message } from "../../src/core/types.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer } from "../fakes/types.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeServer | undefined;
afterEach(() => srv?.stop());
const fast = { baseDelayMs: 1, sleep: async () => {} };

describe("OpenAIResponsesAdapter", () => {
  test("streams text and usage", async () => {
    srv = await startFakeOpenAI([{ text: "hello world", usage: { input: 12, output: 7, cacheRead: 3 } }]);
    const ev = await collect(new OpenAIResponsesAdapter().stream(request(model("openai", srv.url), [userMsg("hi")])));
    expect(ev.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("hello world");
    const d = done(ev);
    expect(d.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 0 });
  });

  test("tool call round trip", async () => {
    srv = await startFakeOpenAI([
      { text: "checking", toolCalls: [{ id: "call_1", name: "Read", input: { path: "a.txt" } }] },
      (body) => ({ text: "saw: " + body.input.find((i: any) => i.type === "function_call_output").output }),
    ]);
    const m = model("openai", srv.url);
    const a = new OpenAIResponsesAdapter();
    const msgs: Message[] = [userMsg("read a.txt")];
    const evs = await collect(a.stream(request(m, msgs)));
    const d1 = done(evs);
    expect(d1.stopReason).toBe("tool_use");
    expect(d1.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.txt" } },
    ]);
    expect(evs.filter((e) => e.type === "tool_input_delta").length).toBeGreaterThan(1);
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "FILE BODY" }] });
    const d2 = done(await collect(a.stream(request(m, msgs))));
    const input = srv.requests[1].input;
    expect(input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "read a.txt" }] });
    expect(input[1]).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] });
    expect(input[2]).toEqual({ type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a.txt"}' });
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "FILE BODY" });
    expect(d2.content).toEqual([{ type: "text", text: "saw: FILE BODY" }]);
  });

  test("request shape", async () => {
    srv = await startFakeOpenAI([{ text: "x" }]);
    const m = model("openai", srv.url + "/v1/", { extraArgs: { service_tier: "flex" } });
    await collect(new OpenAIResponsesAdapter().stream(request(m, [userMsg("hi")])));
    const b = srv.requests[0];
    expect(srv.headers[0]!.authorization).toBe("Bearer test-key");
    expect(b).toMatchObject({
      model: "fake-model", stream: true, store: false, parallel_tool_calls: true, tool_choice: "auto",
      prompt_cache_key: "sess-123", instructions: "identity line\n\nbase prompt", max_output_tokens: 4096, service_tier: "flex",
    });
    expect(b.tools[0]).toMatchObject({ type: "function", name: "Read", strict: false });
    expect(b.reasoning).toBeUndefined();
    expect(b.include).toBeUndefined();
  });

  test("reasoning options only when effort is active", async () => {
    srv = await startFakeOpenAI([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const m = model("openai", srv.url);
    const a = new OpenAIResponsesAdapter();
    await collect(a.stream(request(m, [userMsg("hi")], { reasoningEffort: "high" })));
    await collect(a.stream(request(m, [userMsg("hi")], { reasoningEffort: "off" })));
    await collect(a.stream(request(m, [userMsg("hi")], { reasoningEffort: "dynamic" })));
    expect(srv.requests[0].reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(srv.requests[0].include).toEqual(["reasoning.encrypted_content"]);
    expect(srv.requests[1].reasoning).toBeUndefined();
    expect(srv.requests[2].reasoning).toBeUndefined();
  });

  test("reasoning item replay round trip", async () => {
    srv = await startFakeOpenAI([{ thinking: "I should call Read", toolCalls: [{ id: "call_9", name: "Read", input: {} }] }, { text: "done" }]);
    const m = model("openai", srv.url);
    const a = new OpenAIResponsesAdapter();
    const msgs: Message[] = [userMsg("go")];
    const evs = await collect(a.stream(request(m, msgs, { reasoningEffort: "medium" })));
    const d1 = done(evs);
    expect(evs.filter((e) => e.type === "thinking_delta").length).toBeGreaterThan(0);
    expect(d1.content[0]).toEqual({ type: "thinking", thinking: "I should call Read" });
    expect(d1.openaiReasoning).toEqual([{ id: "rs_fake_0", encryptedContent: "enc-fake-0", summary: "I should call Read" }]);
    // normalized indexes follow output order: reasoning 0, tool call 1
    expect(evs.find((e) => e.type === "tool_use_start")).toMatchObject({ index: 1 });
    msgs.push({ id: "a1", role: "assistant", content: d1.content, openaiReasoning: d1.openaiReasoning });
    msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "ok" }] });
    await collect(a.stream(request(m, msgs, { reasoningEffort: "medium" })));
    const input = srv.requests[1].input;
    expect(input[1]).toEqual({ type: "reasoning", id: "rs_fake_0", encrypted_content: "enc-fake-0", summary: [{ type: "summary_text", text: "I should call Read" }] });
    expect(input[2]).toMatchObject({ type: "function_call", call_id: "call_9" });
    expect(input.filter((i: any) => i.type === "message" && i.role === "assistant").length).toBe(0);
  });

  test("retries 503 then succeeds", async () => {
    srv = await startFakeOpenAI([{ status: 503 }, { text: "ok" }]);
    const seen: string[] = [];
    const ev = await collect(streamWithRetry(new OpenAIResponsesAdapter(), request(model("openai", srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, r) => seen.push(r) }));
    expect(done(ev).content).toEqual([{ type: "text", text: "ok" }]);
    expect(seen).toEqual(["overloaded"]);
  });

  test("429 honours clamped retry-after", async () => {
    srv = await startFakeOpenAI([{ status: 429, headers: { "retry-after": "1" } }, { text: "ok" }]);
    const delays: number[] = [];
    await collect(streamWithRetry(new OpenAIResponsesAdapter(), request(model("openai", srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, _r, d) => delays.push(d) }));
    expect(delays[0]).toBeGreaterThanOrEqual(5000);
    expect(delays[0]).toBeLessThanOrEqual(36000);
  });

  test("500 retried only when body says so", async () => {
    srv = await startFakeOpenAI([{ status: 500, errorBody: { error: { message: "boom" } } }]);
    const e1 = await collect(new OpenAIResponsesAdapter().stream(request(model("openai", srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(e1.retryable).toBe(false);
    srv.stop();
    srv = await startFakeOpenAI([{ status: 500, errorBody: { error: { message: "The server had an internal error" } } }]);
    const e2 = await collect(new OpenAIResponsesAdapter().stream(request(model("openai", srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(e2.retryable).toBe(true);
  });

  test("400 is not retried", async () => {
    srv = await startFakeOpenAI([{ status: 400, errorBody: { error: { message: "bad" } } }, { text: "ok" }]);
    const err = await collect(streamWithRetry(new OpenAIResponsesAdapter(), request(model("openai", srv.url), [userMsg("hi")]), fast)).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("rejected");
    expect(srv.requests.length).toBe(1);
  });

  test("mid-stream break is retried", async () => {
    srv = await startFakeOpenAI([{ text: "partial answer", breakMidStream: true }, { text: "full answer" }]);
    const seen: string[] = [];
    const ev = await collect(streamWithRetry(new OpenAIResponsesAdapter(), request(model("openai", srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, r) => seen.push(r) }));
    expect(done(ev).content).toEqual([{ type: "text", text: "full answer" }]);
    expect(seen).toEqual(["network"]);
  });

  test("empty response is retried once, then fails", async () => {
    srv = await startFakeOpenAI([{}, {}, { text: "never" }]);
    const err = await collect(streamWithRetry(new OpenAIResponsesAdapter(), request(model("openai", srv.url), [userMsg("hi")]), fast)).catch((e) => e);
    expect(err.kind).toBe("empty_response");
    expect(srv.requests.length).toBe(2);
  });
});
