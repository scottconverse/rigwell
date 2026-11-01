import { afterEach, describe, expect, test } from "bun:test";
import { ChatCompletionsAdapter, buildChatBody } from "../../src/adapters/chat.ts";
import { createAdapter, streamWithRetry } from "../../src/adapters/index.ts";
import { ModelError, type Message } from "../../src/core/types.ts";
import { resolveModels } from "../../src/storage/models.ts";
import { startFakeChat } from "../fakes/fake-chat.ts";
import type { FakeServer } from "../fakes/types.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeServer | undefined;
afterEach(() => srv?.stop());
const fast = { baseDelayMs: 1, sleep: async () => {} };
const M = (url: string, extra = {}) => model("generic-chat-completion-api", url, extra);

describe("ChatCompletionsAdapter", () => {
  test("registered in createAdapter", () => {
    expect(createAdapter(M("http://x"))).toBeInstanceOf(ChatCompletionsAdapter);
  });

  test("streams text, usage with cached tokens, request shape", async () => {
    srv = await startFakeChat([{ text: "hello world", usage: { input: 12, output: 7, cacheRead: 3 } }]);
    const m = M(srv.url, { extraHeaders: { "x-extra": "1" }, extraArgs: { temperature: 0.2 } });
    const ev = await collect(new ChatCompletionsAdapter().stream(request(m, [userMsg("hi")])));
    expect(ev.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("hello world");
    const d = done(ev);
    expect(d.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 0 });
    const b = srv.requests[0];
    expect(b.stream).toBe(true);
    expect(b.prompt_cache_key).toBe("sess-123");
    expect(b.temperature).toBe(0.2);
    expect(b.messages[0]).toEqual({ role: "system", content: "identity line\n\nbase prompt" });
    expect(b.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(b.tools[0]).toEqual({ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } });
    expect(srv.headers[0]!["x-extra"]).toBe("1");
    expect(srv.headers[0]!.authorization).toBe("Bearer test-key");
  });

  test("stop reasons", async () => {
    srv = await startFakeChat([{ text: "cut", finishReason: "length" }]);
    const d = done(await collect(new ChatCompletionsAdapter().stream(request(M(srv.url), [userMsg("hi")]))));
    expect(d.stopReason).toBe("max_tokens");
  });

  test("tool call round trip assembles deltas by index", async () => {
    srv = await startFakeChat([
      { text: "checking", toolCalls: [{ id: "call_1", name: "Read", input: { path: "a.txt" } }, { id: "call_2", name: "Read", input: { path: "b.txt" } }] },
      (body) => ({ text: "saw: " + body.messages.filter((x: any) => x.role === "tool").map((x: any) => x.content).join("|") }),
    ]);
    const m = M(srv.url);
    const a = new ChatCompletionsAdapter();
    const msgs: Message[] = [userMsg("read")];
    const evs = await collect(a.stream(request(m, msgs)));
    const d1 = done(evs);
    expect(d1.stopReason).toBe("tool_use");
    expect(d1.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.txt" } },
      { type: "tool_use", id: "call_2", name: "Read", input: { path: "b.txt" } },
    ]);
    expect(evs.filter((e) => e.type === "tool_input_delta").length).toBeGreaterThan(2);
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "A" },
      { type: "tool_result", tool_use_id: "call_2", content: "B" },
    ] });
    const d2 = done(await collect(a.stream(request(m, msgs))));
    const sent = srv.requests[1].messages;
    expect(sent[2]).toEqual({
      role: "assistant", content: "checking",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
        { id: "call_2", type: "function", function: { name: "Read", arguments: '{"path":"b.txt"}' } },
      ],
    });
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "A" });
    expect(sent[4]).toEqual({ role: "tool", tool_call_id: "call_2", content: "B" });
    expect(d2.content).toEqual([{ type: "text", text: "saw: A|B" }]);
  });

  for (const field of ["reasoning", "reasoning_content"] as const) {
    test(`reasoning field round trip: ${field}`, async () => {
      srv = await startFakeChat([
        { thinking: "let me think", reasoningField: field, toolCalls: [{ id: "c1", name: "Read", input: { path: "a" } }] },
        { text: "ok" },
      ]);
      const m = M(srv.url);
      const a = new ChatCompletionsAdapter();
      const msgs: Message[] = [userMsg("go")];
      const evs = await collect(a.stream(request(m, msgs)));
      expect(evs.filter((e) => e.type === "thinking_delta").map((e: any) => e.text).join("")).toBe("let me think");
      const d1 = done(evs);
      expect(d1.content[0]).toMatchObject({ type: "thinking", thinking: "let me think" });
      msgs.push({ id: "a1", role: "assistant", content: d1.content });
      msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "X" }] });
      await collect(a.stream(request(m, msgs)));
      const asst = srv.requests[1].messages.find((x: any) => x.role === "assistant");
      expect(asst[field]).toBe("let me think");
      expect(asst[field === "reasoning" ? "reasoning_content" : "reasoning"]).toBeUndefined();
    });
  }

  test("reasoning replay defaults to reasoning_content with a single space when empty", () => {
    const m = M("http://x");
    const msgs: Message[] = [userMsg("go"), { id: "a", role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] }];
    const on = buildChatBody(request(m, msgs, { reasoningEffort: "high" })) as any;
    expect(on.messages[2].reasoning_content).toBe(" ");
    expect(on.reasoning_effort).toBe("high");
    const off = buildChatBody(request(m, msgs)) as any;
    expect("reasoning_content" in off.messages[2]).toBe(false);
  });

  test("quirk profile: mistral replays thinking parts", () => {
    const msgs: Message[] = [userMsg("go"), { id: "a", role: "assistant", content: [
      { type: "thinking", thinking: "hmm", signature: '{"f":"reasoning_content"}', signatureProvider: "chat" },
      { type: "text", text: "doing it" },
      { type: "tool_use", id: "c1", name: "Read", input: {} },
    ] }];
    const b = buildChatBody(request(M("http://x", { apiProvider: "mistral" }), msgs)) as any;
    expect(b.messages[2].content).toEqual([{ type: "thinking", thinking: [{ type: "text", text: "hmm" }] }, { type: "text", text: "doing it" }]);
    expect(b.messages[2].reasoning_content).toBeUndefined();
  });

  test("quirk profile: together/baseten send no history, opt-in params", () => {
    const msgs: Message[] = [userMsg("go"), { id: "a", role: "assistant", content: [
      { type: "thinking", thinking: "hmm", signature: '{"f":"reasoning_content"}', signatureProvider: "chat" },
      { type: "tool_use", id: "c1", name: "Read", input: {} },
    ] }];
    const t = buildChatBody(request(M("http://x", { apiProvider: "together" }), msgs, { reasoningEffort: "medium" })) as any;
    expect(t.reasoning).toEqual({ enabled: true });
    expect(t.messages[2].reasoning_content).toBeUndefined();
    const b = buildChatBody(request(M("http://x", { apiProvider: "baseten" }), msgs, { reasoningEffort: "off" })) as any;
    expect(b.chat_template_args).toEqual({ enable_thinking: false });
    expect(b.reasoning_effort).toBe("low");
    expect(b.messages[2].reasoning_content).toBeUndefined();
  });

  test("quirk profile: databricks drops unsupported fields", () => {
    const b = buildChatBody(request(M("http://x", { apiProvider: "databricks", extraArgs: { store: false, background: true, keep: 1 } }), [userMsg("x")])) as any;
    expect(b.store).toBeUndefined();
    expect(b.background).toBeUndefined();
    expect(b.keep).toBe(1);
  });

  test("quirk profile: google thought_signature read and replayed", async () => {
    srv = await startFakeChat([
      { toolCalls: [{ id: "g1", name: "Read", input: { path: "a" } }], thoughtSignature: "SIG123" },
      { text: "ok" },
    ]);
    const m = M(srv.url, { apiProvider: "google" });
    const a = new ChatCompletionsAdapter();
    const msgs: Message[] = [userMsg("go")];
    const d1 = done(await collect(a.stream(request(m, msgs))));
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "g1", content: "X" }] });
    await collect(a.stream(request(m, msgs)));
    const call = srv.requests[1].messages.find((x: any) => x.role === "assistant").tool_calls[0];
    expect(call.extra_content).toEqual({ google: { thought_signature: "SIG123" } });
  });

  test("chatCompletionRequest merge order: profile < model < api-provider", () => {
    const m = M("http://x", {
      apiProvider: "together",
      chatCompletionRequest: { top_p: 0.5, reasoning: { enabled: "model" } },
      chatCompletionRequestByProvider: { together: { reasoning: { enabled: "provider" } }, mistral: { top_p: 0.1 } },
    });
    const b = buildChatBody(request(m, [userMsg("x")], { reasoningEffort: "high" })) as any;
    expect(b.reasoning).toEqual({ enabled: "provider" });
    expect(b.top_p).toBe(0.5);
    const b2 = buildChatBody(request({ ...m, chatCompletionRequestByProvider: {} }, [userMsg("x")], { reasoningEffort: "high" })) as any;
    expect(b2.reasoning).toEqual({ enabled: "model" });
    const b3 = buildChatBody(request({ ...m, chatCompletionRequest: {}, chatCompletionRequestByProvider: {} }, [userMsg("x")], { reasoningEffort: "high" })) as any;
    expect(b3.reasoning).toEqual({ enabled: true });
  });

  test("retries: 503 then success; 400 is not retried; mid-stream break retried", async () => {
    srv = await startFakeChat([{ status: 503 }, { breakMidStream: true, text: "partial text here" }, { text: "fine" }]);
    const retries: string[] = [];
    const ev = await collect(streamWithRetry(new ChatCompletionsAdapter(), request(M(srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, r) => retries.push(r) }));
    expect(retries).toEqual(["overloaded", "network"]);
    expect(done(ev).content).toEqual([{ type: "text", text: "fine" }]);
    srv.stop();
    srv = await startFakeChat([{ status: 400 }, { text: "never" }]);
    await expect(collect(streamWithRetry(new ChatCompletionsAdapter(), request(M(srv.url), [userMsg("hi")]), fast))).rejects.toBeInstanceOf(ModelError);
    expect(srv.requests.length).toBe(1);
  });

  test("429 honours retry-after", async () => {
    srv = await startFakeChat([{ status: 429, headers: { "retry-after": "1" } }, { text: "ok" }]);
    const delays: number[] = [];
    await collect(streamWithRetry(new ChatCompletionsAdapter(), request(M(srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, _r, d) => delays.push(d) }));
    expect(delays[0]).toBeGreaterThanOrEqual(5000);
  });
});

describe("custom model config", () => {
  test("accepts the provider, defaults noImageSupport to true, keeps apiProvider", () => {
    const models = resolveModels({ customModels: [
      { model: "m", provider: "generic-chat-completion-api", baseUrl: "http://x", apiProvider: "mistral" },
      { model: "n", provider: "generic-chat-completion-api", baseUrl: "http://x", noImageSupport: false },
      { model: "o", provider: "openai", baseUrl: "http://x" },
    ] });
    expect(models.map((m) => m.noImageSupport)).toEqual([true, false, undefined]);
    expect(models[0]!.apiProvider).toBe("mistral");
  });
});
