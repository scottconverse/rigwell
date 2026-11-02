import { afterEach, describe, expect, test } from "bun:test";
import { BedrockAnthropicAdapter, BedrockConverseAdapter, buildBedrockAnthropicBody, buildConverseBody, mapConverseStop } from "../../src/adapters/bedrock.ts";
import { clearAwsCredentialCache } from "../../src/adapters/bedrock-auth.ts";
import { createAdapter, streamWithRetry } from "../../src/adapters/index.ts";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai.ts";
import type { Message } from "../../src/core/types.ts";
import { startFakeBedrock, type FakeBedrockServer, type FakeBedrockTurnSpec } from "../fakes/fake-bedrock.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer } from "../fakes/types.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeBedrockServer | undefined;
let oai: FakeServer | undefined;
afterEach(() => { srv?.stop(); oai?.stop(); clearAwsCredentialCache(); });
const BEARER = { awsRegion: "us-east-1" };
const CM = (url: string, extra: object = {}) => model("bedrock-converse", url, { model: "us.anthropic.claude-sonnet-4-v1:0", bedrock: BEARER, ...extra });

describe("Bedrock Converse", () => {
  test("createAdapter picks the adapters", () => {
    expect(createAdapter(CM("http://x"))).toBeInstanceOf(BedrockConverseAdapter);
    expect(createAdapter(model("anthropic", "http://x", { bedrock: BEARER }))).toBeInstanceOf(BedrockAnthropicAdapter);
    expect(createAdapter(model("openai", "http://x", { bedrock: BEARER }))).toBeInstanceOf(OpenAIResponsesAdapter);
  });

  test("streams text, reasoning with its signature, and usage; bearer auth; request shape", async () => {
    srv = await startFakeBedrock([{ thinking: "hmm", text: "hello world", usage: { input: 12, output: 7, cacheRead: 3, cacheCreation: 2 } } as FakeBedrockTurnSpec]);
    const ev = await collect(new BedrockConverseAdapter().stream(request(CM(srv.url), [userMsg("hi")], { reasoningEffort: "medium" })));
    expect(ev.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("hello world");
    expect(ev.filter((e) => e.type === "thinking_delta").map((e: any) => e.text).join("")).toBe("hmm");
    const d = done(ev);
    expect(d.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig-bedrock", signatureProvider: "bedrock" },
      { type: "text", text: "hello world" },
    ]);
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheCreationTokens: 2, cacheReadTokens: 3, thinkingTokens: 0 });
    expect(srv.paths[0]).toBe("/model/us.anthropic.claude-sonnet-4-v1%3A0/converse-stream");
    expect(srv.headers[0]!.authorization).toBe("Bearer test-key");
    const b = srv.requests[0];
    expect(b.system).toEqual([{ text: "identity line" }, { text: "base prompt" }]);
    expect(b.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
    expect(b.inferenceConfig).toEqual({ maxTokens: 4096 });
    expect(b.toolConfig.tools[0].toolSpec.name).toBe("Read");
    expect(b.toolConfig.tools[0].toolSpec.inputSchema.json.type).toBe("object");
    expect(b.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 3072 } });
  });

  test("tool call round trip with a reasoning block replayed", async () => {
    srv = await startFakeBedrock([
      { thinking: "plan", toolCalls: [{ id: "tu_1", name: "Read", input: { path: "a.txt" } }] } as FakeBedrockTurnSpec,
      (body) => ({ text: "saw: " + body.messages.at(-1).content[0].toolResult.content[0].text }),
    ]);
    const m = CM(srv.url);
    const a = new BedrockConverseAdapter();
    const msgs: Message[] = [userMsg("read a.txt")];
    const evs = await collect(a.stream(request(m, msgs)));
    const d1 = done(evs);
    expect(d1.stopReason).toBe("tool_use");
    expect(d1.content[1]).toEqual({ type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.txt" } });
    expect(evs.filter((e) => e.type === "tool_input_delta").length).toBeGreaterThan(1);
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }] });
    const d2 = done(await collect(a.stream(request(m, msgs))));
    expect(d2.content).toEqual([{ type: "text", text: "saw: file body" }]);
    const sent = srv.requests[1].messages;
    expect(sent[1]).toEqual({ role: "assistant", content: [
      { reasoningContent: { reasoningText: { text: "plan", signature: "sig-bedrock" } } },
      { toolUse: { toolUseId: "tu_1", name: "Read", input: { path: "a.txt" } } },
    ] });
    expect(sent[2].content[0].toolResult.status).toBe("success");
  });

  test("stop reasons map as the spec says", () => {
    expect(mapConverseStop("end_turn")).toBe("end_turn");
    expect(mapConverseStop("stop_sequence")).toBe("end_turn");
    expect(mapConverseStop("tool_use")).toBe("tool_use");
    expect(mapConverseStop("max_tokens")).toBe("max_tokens");
    expect(mapConverseStop("guardrail_intervened")).toBe("other");
    expect(mapConverseStop("content_filtered")).toBe("other");
  });

  test("max_tokens and a content filter come through the stream", async () => {
    srv = await startFakeBedrock([{ text: "cut", stopReason: "max_tokens" } as FakeBedrockTurnSpec, { text: "x", stopReason: "guardrail_intervened" } as FakeBedrockTurnSpec]);
    const m = CM(srv.url);
    expect(done(await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("1")])))).stopReason).toBe("max_tokens");
    expect(done(await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("2")])))).stopReason).toBe("other");
  });

  test("tool results carry errors and images; user tool results come first", () => {
    const body = buildConverseBody(request(CM("http://x"), [
      { id: "u", role: "user", content: [{ type: "text", text: "note" }, { type: "tool_result", tool_use_id: "t", content: "boom", is_error: true, images: [{ type: "image", mediaType: "image/png", data: "QUJD" }] }] },
    ]));
    expect((body.messages as any)[0].content[0]).toEqual({ toolResult: { toolUseId: "t", status: "error", content: [{ text: "boom" }, { image: { format: "png", source: { bytes: "QUJD" } } }] } });
    expect((body.messages as any)[0].content[1]).toEqual({ text: "note" });
  });

  test("SigV4 with access keys signs the request; session token is sent", async () => {
    srv = await startFakeBedrock([{ text: "ok" }]);
    const m = CM(srv.url, { apiKey: undefined, bedrock: { awsRegion: "eu-west-1", awsAccessKeyId: "AKID", awsSecretAccessKey: "SECRET", awsSessionToken: "SESS" } });
    await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("hi")])));
    const h = srv.headers[0]!;
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(h["x-amz-security-token"]).toBe("SESS");
    expect(h["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  test("makes exactly one request per attempt: HTTP and stream errors are mapped, never retried inside", async () => {
    srv = await startFakeBedrock([
      { status: 429, errorBody: { message: "Too many requests" }, headers: { "retry-after": "1" } },
      { text: "partial", exception: "throttlingException" } as FakeBedrockTurnSpec,
      { status: 403, errorBody: { message: "no access" } },
    ]);
    const m = CM(srv.url);
    const e1: any = await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("1")]))).catch((e) => e);
    expect(e1.kind).toBe("rate_limited");
    expect(srv.requests.length).toBe(1);
    const e2: any = await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("2")]))).catch((e) => e);
    expect(e2.kind).toBe("rate_limited");
    expect(e2.message).toContain("throttlingException");
    expect(srv.requests.length).toBe(2);
    const e3: any = await collect(new BedrockConverseAdapter().stream(request(m, [userMsg("3")]))).catch((e) => e);
    expect(e3.kind).toBe("auth");
    expect(srv.requests.length).toBe(3);
  });

  test("the harness retry wrapper retries a throttled call", async () => {
    srv = await startFakeBedrock([{ status: 429, errorBody: { message: "slow down" } }, { text: "after retry" }]);
    const ev = await collect(streamWithRetry(new BedrockConverseAdapter(), request(CM(srv.url), [userMsg("hi")]), { baseDelayMs: 1, sleep: async () => {} }));
    expect(done(ev).content).toEqual([{ type: "text", text: "after retry" }]);
    expect(srv.requests.length).toBe(2);
  });

  test("a stream cut before messageStop is a network error", async () => {
    srv = await startFakeBedrock([{ text: "partial answer", breakMidStream: true }]);
    const err: any = await collect(new BedrockConverseAdapter().stream(request(CM(srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(err.kind).toBe("network");
  });
});

describe("Bedrock Anthropic (Messages format)", () => {
  const AM = (url: string, extra: object = {}) => model("anthropic", url, { model: "anthropic.claude-sonnet-4-v1:0", bedrock: BEARER, ...extra });

  test("InvokeModelWithResponseStream with the Messages body, no model or stream fields", async () => {
    srv = await startFakeBedrock([
      { thinking: "t", text: "checking", toolCalls: [{ id: "toolu_1", name: "Read", input: { path: "a" } }] },
      { text: "done" },
    ]);
    const m = AM(srv.url);
    const a = new BedrockAnthropicAdapter();
    const msgs: Message[] = [userMsg("go")];
    const d1 = done(await collect(a.stream(request(m, msgs))));
    expect(d1.stopReason).toBe("tool_use");
    expect(d1.content).toEqual([
      { type: "thinking", thinking: "t", signature: "sig-fake", signatureProvider: "anthropic" },
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
    ]);
    expect(srv.paths[0]).toBe("/model/anthropic.claude-sonnet-4-v1%3A0/invoke-with-response-stream");
    const b = srv.requests[0];
    expect(b.anthropic_version).toBe("bedrock-2023-05-31");
    expect(b.model).toBeUndefined();
    expect(b.stream).toBeUndefined();
    expect(b.max_tokens).toBe(4096);
    expect(b.tools[0].input_schema).toBeDefined();
    expect(srv.headers[0]!.authorization).toBe("Bearer test-key");
    msgs.push({ id: "a1", role: "assistant", content: d1.content }, { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }] });
    expect(done(await collect(a.stream(request(m, msgs)))).content).toEqual([{ type: "text", text: "done" }]);
  });

  test("cache markers lose the one-hour ttl", () => {
    const body = buildBedrockAnthropicBody(request(AM("http://x"), [userMsg("hi")]));
    const text = JSON.stringify(body);
    expect(text).toContain('"cache_control":{"type":"ephemeral"}');
    expect(text).not.toContain("ttl");
  });

  test("exceptions inside the stream are mapped", async () => {
    srv = await startFakeBedrock([{ text: "x", exception: "serviceUnavailableException" } as FakeBedrockTurnSpec]);
    const err: any = await collect(new BedrockAnthropicAdapter().stream(request(AM(srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(err.kind).toBe("unavailable");
    expect(err.retryable).toBe(true);
  });
});

describe("Bedrock OpenAI (Responses)", () => {
  test("Responses request with a Bedrock model id, bearer auth, and effort none sent as {effort:none}", async () => {
    oai = await startFakeOpenAI([{ text: "hello from bedrock" }]);
    const m = model("openai", oai.url, { model: "openai.gpt-5.4", bedrock: BEARER, apiKey: "bedrock-key" });
    const d = done(await collect(createAdapter(m).stream(request(m, [userMsg("hi")], { reasoningEffort: "none" }))));
    expect(d.content).toEqual([{ type: "text", text: "hello from bedrock" }]);
    expect(oai.requests[0].model).toBe("openai.gpt-5.4");
    expect(oai.requests[0].reasoning).toEqual({ effort: "none" });
    expect(oai.requests[0].include).toBeUndefined();
    expect(oai.headers[0]!.authorization).toBe("Bearer bedrock-key");
  });

  test("SigV4 signs the Responses request with service bedrock-mantle", async () => {
    oai = await startFakeOpenAI([{ text: "ok" }]);
    const m = model("openai", oai.url, { model: "openai.gpt-5.4", apiKey: undefined, bedrock: { awsRegion: "us-west-2", awsAccessKeyId: "AK", awsSecretAccessKey: "SK" } });
    await collect(createAdapter(m).stream(request(m, [userMsg("hi")])));
    expect(oai.headers[0]!.authorization).toMatch(/Credential=AK\/\d{8}\/us-west-2\/bedrock-mantle\/aws4_request/);
  });
});
