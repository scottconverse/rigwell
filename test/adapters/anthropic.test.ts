import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "../../src/adapters/anthropic.ts";
import { streamWithRetry } from "../../src/adapters/retry.ts";
import { ModelError, type Message } from "../../src/core/types.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeServer | undefined;
afterEach(() => srv?.stop());
const fast = { baseDelayMs: 1, sleep: async () => {} };

describe("AnthropicAdapter", () => {
  test("streams text and usage", async () => {
    srv = await startFakeAnthropic([{ text: "hello world", usage: { input: 12, output: 7, cacheRead: 3 } }]);
    const ev = await collect(new AnthropicAdapter().stream(request(model("anthropic", srv.url), [userMsg("hi")])));
    const text = ev.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("");
    expect(text).toBe("hello world");
    expect(ev.filter((e) => e.type === "text_delta").length).toBeGreaterThan(1);
    const d = done(ev);
    expect(d.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 0 });
  });

  test("tool call round trip", async () => {
    srv = await startFakeAnthropic([
      { text: "let me look", toolCalls: [{ id: "toolu_1", name: "Read", input: { path: "a.txt" } }] },
      (body) => ({ text: "saw: " + JSON.stringify(body.messages.at(-1).content[0].content) }),
    ]);
    const m = model("anthropic", srv.url);
    const a = new AnthropicAdapter();
    const msgs: Message[] = [userMsg("read a.txt")];
    const d1 = done(await collect(a.stream(request(m, msgs))));
    expect(d1.stopReason).toBe("tool_use");
    expect(d1.content[1]).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } });
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "FILE BODY", is_error: false }] });
    const d2 = done(await collect(a.stream(request(m, msgs))));
    const second = srv.requests[1];
    expect(second.messages[1].content[1]).toEqual({ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } });
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", content: "FILE BODY", is_error: false });
    expect(d2.content).toEqual([{ type: "text", text: 'saw: "FILE BODY"' }]);
  });

  test("tool_use with no input deltas parses to {}", async () => {
    srv = await startFakeAnthropic([{ toolCalls: [{ name: "Ls", input: {} }] }]);
    const d = done(await collect(new AnthropicAdapter().stream(request(model("anthropic", srv.url), [userMsg("x")]))));
    expect(d.content).toEqual([{ type: "tool_use", id: "toolu_fake_0_0", name: "Ls", input: {} }]);
  });

  test("thinking signature is kept and replayed", async () => {
    srv = await startFakeAnthropic([{ thinking: "hmm", text: "ok" }, { text: "again" }]);
    const m = model("anthropic", srv.url);
    const d1 = done(await collect(new AnthropicAdapter().stream(request(m, [userMsg("q")]))));
    expect(d1.content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig-fake", signatureProvider: "anthropic" });
    await collect(new AnthropicAdapter().stream(request(m, [userMsg("q"), { id: "a", role: "assistant", content: d1.content }, userMsg("more", "u2")])));
    expect(srv.requests[1].messages[1].content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig-fake" });
  });

  test("request shape", async () => {
    srv = await startFakeAnthropic([{ text: "x" }]);
    const m = model("anthropic", srv.url + "/", { extraHeaders: { "x-extra": "1" }, extraArgs: { temperature: 0.5 } });
    await collect(new AnthropicAdapter().stream(request(m, [userMsg("first", "u1"), { id: "a", role: "assistant", content: [{ type: "text", text: "r" }] }, userMsg("newest", "u2")])));
    const b = srv.requests[0];
    const h = srv.headers[0]!;
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["x-api-key"]).toBe("test-key");
    expect(h["x-extra"]).toBe("1");
    expect(b.model).toBe("fake-model");
    expect(b.max_tokens).toBe(4096);
    expect(b.stream).toBe(true);
    expect(b.temperature).toBe(0.5);
    const cc = { type: "ephemeral", ttl: "1h" };
    expect(b.system).toEqual([{ type: "text", text: "identity line" }, { type: "text", text: "base prompt", cache_control: cc }]);
    expect(b.tools[0]).toEqual({ name: "Read", description: "Read a file", input_schema: expect.any(Object) });
    expect(b.messages[2].content.at(-1).cache_control).toEqual(cc);
    expect(b.messages[0].content[0].cache_control).toBeUndefined();
  });

  test("baseUrl ending in /v1 is not doubled", async () => {
    srv = await startFakeAnthropic([{ text: "x" }]);
    const d = done(await collect(new AnthropicAdapter().stream(request(model("anthropic", srv.url + "/v1"), [userMsg("hi")]))));
    expect(d.content.length).toBe(1);
  });

  test("retries 529 then succeeds", async () => {
    srv = await startFakeAnthropic([{ status: 529, errorBody: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { text: "ok" }]);
    const seen: string[] = [];
    const ev = await collect(streamWithRetry(new AnthropicAdapter(), request(model("anthropic", srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, r) => seen.push(r) }));
    expect(done(ev).content).toEqual([{ type: "text", text: "ok" }]);
    expect(srv.requests.length).toBe(2);
    expect(seen).toEqual(["overloaded"]);
  });

  test("400 is not retried", async () => {
    srv = await startFakeAnthropic([{ status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "bad" } } }, { text: "ok" }]);
    const err = await collect(streamWithRetry(new AnthropicAdapter(), request(model("anthropic", srv.url), [userMsg("hi")]), fast)).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe("rejected");
    expect(err.retryable).toBe(false);
    expect(srv.requests.length).toBe(1);
  });

  test("401 maps to auth; x-should-retry false stops retry", async () => {
    srv = await startFakeAnthropic([{ status: 401 }, { status: 529, headers: { "x-should-retry": "false" } }]);
    const a = new AnthropicAdapter();
    const e1 = await collect(a.stream(request(model("anthropic", srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(e1.kind).toBe("auth");
    const e2 = await collect(a.stream(request(model("anthropic", srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(e2.kind).toBe("overloaded");
    expect(e2.retryable).toBe(false);
  });

  test("mid-stream break is retried and final message is the complete one", async () => {
    srv = await startFakeAnthropic([{ text: "partial answer", breakMidStream: true }, { text: "full answer" }]);
    const seen: string[] = [];
    const ev = await collect(streamWithRetry(new AnthropicAdapter(), request(model("anthropic", srv.url), [userMsg("hi")]), { ...fast, onRetry: (_a, r) => seen.push(r) }));
    expect(done(ev).content).toEqual([{ type: "text", text: "full answer" }]);
    expect(seen).toEqual(["network"]);
    expect(srv.requests.length).toBe(2);
  });

  test("gives up after max attempts", async () => {
    srv = await startFakeAnthropic([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    const err = await collect(streamWithRetry(new AnthropicAdapter(), request(model("anthropic", srv.url), [userMsg("hi")]), { ...fast, strategy: "interactive" })).catch((e) => e);
    expect(err.kind).toBe("unavailable");
    expect(srv.requests.length).toBe(4);
  });

  test("script exhausted yields a clear 500 (not retried: no matching body)", async () => {
    srv = await startFakeAnthropic([]);
    const err = await collect(new AnthropicAdapter().stream(request(model("anthropic", srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(err.message).toContain("script exhausted");
  });

  test("abort signal stops the request", async () => {
    srv = await startFakeAnthropic([{ text: "x" }]);
    const ctl = new AbortController();
    ctl.abort();
    const err = await collect(new AnthropicAdapter().stream(request(model("anthropic", srv.url), [userMsg("hi")], { signal: ctl.signal }))).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.retryable).toBe(false);
  });
});
