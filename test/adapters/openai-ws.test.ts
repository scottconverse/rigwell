// OpenAI Responses over WebSocket (spec 4.6.3) against the fake WS server.
import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIResponsesAdapter, buildOpenAIBody } from "../../src/adapters/openai.ts";
import { closeOpenAIWs, wsEligible, wsSessionState, type WsOptions } from "../../src/adapters/openai-ws.ts";
import type { Message, ModelRequest } from "../../src/core/types.ts";
import { startFakeOpenAIWs, type FakeWsServer, type FakeWsTurnSpec } from "../fakes/fake-openai-ws.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeWsServer | undefined;
let n = 0;
const sid = () => `ws-sess-${++n}`;
afterEach(() => { srv?.stop(); closeOpenAIWs(); });
const FORCE: WsOptions = { mode: "force" };

/** One turn through the adapter; returns the assistant message to append. */
async function turn(a: OpenAIResponsesAdapter, req: ModelRequest) {
  const d = done(await collect(a.stream(req)));
  const msg: Message = { id: `a${n++}`, role: "assistant", content: d.content, ...(d.openaiReasoning ? { openaiReasoning: d.openaiReasoning } : {}) };
  return { d, msg };
}
const toolResult = (id: string, content: string): Message => ({ id: `t${n++}`, role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] });

describe("WebSocket transport", () => {
  test("sends response.create with the HTTP body over ws and returns the answer", async () => {
    srv = await startFakeOpenAIWs([{ text: "over the socket" }]);
    const s = sid();
    const m = model("openai", srv.url);
    const { d } = await turn(new OpenAIResponsesAdapter({ ws: FORCE }), request(m, [userMsg("hi")], { sessionId: s }));
    expect(d.content).toEqual([{ type: "text", text: "over the socket" }]);
    expect(srv.frames.length).toBe(1);
    expect(srv.httpRequests.length).toBe(0);
    const f = srv.frames[0];
    expect(f.type).toBe("response.create");
    expect(f.model).toBe("fake-model");
    expect(f.store).toBe(false);
    expect(f.prompt_cache_key).toBe(s);
    expect(f.previous_response_id).toBeUndefined();
    expect(srv.headers[0]!.authorization).toBe("Bearer test-key");
    expect(wsSessionState(s).lastMode).toBe("ws_full");
  });

  test("chains with previous_response_id when the input extends the previous context, else sends everything", async () => {
    srv = await startFakeOpenAIWs([
      { text: "looking", toolCalls: [{ id: "call_1", name: "Read", input: { path: "a" } }] },
      { text: "second", toolCalls: [{ id: "call_2", name: "Read", input: { path: "b" } }] },
      { text: "third" },
      { text: "fourth" },
    ]);
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const m = model("openai", srv.url);
    const msgs: Message[] = [userMsg("go")];
    const t1 = await turn(a, request(m, msgs, { sessionId: s }));
    msgs.push(t1.msg, toolResult("call_1", "file a"));
    const t2 = await turn(a, request(m, msgs, { sessionId: s }));
    expect(wsSessionState(s).lastMode).toBe("ws_chained");
    const f2 = srv.frames[1];
    expect(f2.previous_response_id).toBe("resp_fake_0");
    expect(f2.input).toEqual([{ type: "function_call_output", call_id: "call_1", output: "file a" }]);
    expect(f2.instructions).toBeDefined(); // everything but the input is sent again

    msgs.push(t2.msg, toolResult("call_2", "file b"));
    await turn(a, request(m, msgs, { sessionId: s }));
    expect(srv.frames[2].previous_response_id).toBe("resp_fake_1");
    expect(srv.frames[2].input.length).toBe(1);

    // The history was rewritten (compaction): not a continuation, so the whole input goes out.
    const rewritten: Message[] = [userMsg("a summary of the work so far"), userMsg("next question", "u9")];
    await turn(a, request(m, rewritten, { sessionId: s }));
    expect(wsSessionState(s).lastMode).toBe("ws_full");
    expect(srv.frames[3].previous_response_id).toBeUndefined();
    expect(srv.frames[3].input.length).toBe(2);
    expect(srv.upgrades).toBe(1); // one socket for all four turns
  });

  test("a model change resets the chain", async () => {
    srv = await startFakeOpenAIWs([{ text: "one", toolCalls: [{ id: "c1", name: "Read", input: {} }] }, { text: "two" }]);
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const msgs: Message[] = [userMsg("go")];
    const t1 = await turn(a, request(model("openai", srv.url), msgs, { sessionId: s }));
    msgs.push(t1.msg, toolResult("c1", "x"));
    await turn(a, request(model("openai", srv.url, { model: "other-model" }), msgs, { sessionId: s }));
    expect(wsSessionState(s).lastMode).toBe("ws_full");
    expect(srv.frames[1].previous_response_id).toBeUndefined();
    expect(srv.frames[1].input.length).toBe(msgs.length + 1); // user, assistant text, function_call, output
  });

  test("an error frame resets the chain and is reported as an error", async () => {
    srv = await startFakeOpenAIWs([
      { text: "one", toolCalls: [{ id: "c1", name: "Read", input: {} }] },
      { wsError: { status: 400, code: "invalid_request", message: "bad input" } } as FakeWsTurnSpec,
      { text: "three" },
    ]);
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const m = model("openai", srv.url);
    const msgs: Message[] = [userMsg("go")];
    const t1 = await turn(a, request(m, msgs, { sessionId: s }));
    msgs.push(t1.msg, toolResult("c1", "x"));
    expect(srv.frames.length).toBe(1);
    const err: any = await collect(a.stream(request(m, msgs, { sessionId: s }))).catch((e) => e);
    expect(err.kind).toBe("rejected");
    expect(srv.frames[1].previous_response_id).toBe("resp_fake_0");
    await turn(a, request(m, msgs, { sessionId: s }));
    expect(srv.frames[2].previous_response_id).toBeUndefined();
    expect(srv.frames[2].input.length).toBe(4);
  });

  test("two transport failures turn the socket off for the session", async () => {
    srv = await startFakeOpenAIWs([], { rejectUpgrades: 5, httpScript: [{ text: "h1" }, { text: "h2" }, { text: "h3" }] });
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const m = model("openai", srv.url);
    for (const want of ["h1", "h2", "h3"]) {
      const { d } = await turn(a, request(m, [userMsg("hi")], { sessionId: s }));
      expect(d.content).toEqual([{ type: "text", text: want }]);
    }
    expect(srv.upgrades).toBe(2); // the third request did not even try
    expect(srv.httpRequests.length).toBe(3);
    expect(wsSessionState(s).disabled).toBe(true);
  });

  test("close code 1009 switches to HTTP for the rest of the session at once", async () => {
    srv = await startFakeOpenAIWs([{ closeWith: 1009 } as FakeWsTurnSpec], { httpScript: [{ text: "h1" }, { text: "h2" }] });
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const m = model("openai", srv.url);
    const t1 = await turn(a, request(m, [userMsg("hi")], { sessionId: s }));
    expect(t1.d.content).toEqual([{ type: "text", text: "h1" }]);
    const t2 = await turn(a, request(m, [userMsg("again")], { sessionId: s }));
    expect(t2.d.content).toEqual([{ type: "text", text: "h2" }]);
    expect(srv.upgrades).toBe(1);
    expect(wsSessionState(s).disabledReason).toContain("1009");
  });

  test("a socket that drops after output started is a retryable network error, and counts as a failure", async () => {
    srv = await startFakeOpenAIWs([{ text: "partial answer", dropMidStream: true } as FakeWsTurnSpec], { httpScript: [{ text: "ok" }] });
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: FORCE });
    const m = model("openai", srv.url);
    const err: any = await collect(a.stream(request(m, [userMsg("hi")], { sessionId: s }))).catch((e) => e);
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
    expect(wsSessionState(s).failures).toBe(1);
    expect(wsSessionState(s).disabled).toBe(false);
  });

  test("connect timeout falls back to HTTP", async () => {
    srv = await startFakeOpenAIWs([{ text: "never" }], { connectDelayMs: 400, httpScript: [{ text: "via http" }] });
    const s = sid();
    const t0 = Date.now();
    const { d } = await turn(new OpenAIResponsesAdapter({ ws: { ...FORCE, connectTimeoutMs: 40 } }), request(model("openai", srv.url), [userMsg("hi")], { sessionId: s }));
    expect(d.content).toEqual([{ type: "text", text: "via http" }]);
    expect(Date.now() - t0).toBeLessThan(380);
    expect(wsSessionState(s).failures).toBe(1);
  });

  test("pings during a turn", async () => {
    srv = await startFakeOpenAIWs([{ text: "slow", delayMs: 250 } as FakeWsTurnSpec]);
    const s = sid();
    await turn(new OpenAIResponsesAdapter({ ws: { ...FORCE, pingIntervalMs: 30 } }), request(model("openai", srv.url), [userMsg("hi")], { sessionId: s }));
    expect(srv.pings).toBeGreaterThanOrEqual(3);
  });

  test("an idle socket is closed after the idle period and reopened on the next turn", async () => {
    srv = await startFakeOpenAIWs([{ text: "a" }, { text: "b" }]);
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: { ...FORCE, idleCloseMs: 60 } });
    const m = model("openai", srv.url);
    await turn(a, request(m, [userMsg("1")], { sessionId: s }));
    expect(srv.open()).toBe(1);
    await Bun.sleep(250);
    expect(srv.open()).toBe(0);
    expect(srv.closes[0]!.code).toBe(1000);
    await turn(a, request(m, [userMsg("2")], { sessionId: s }));
    expect(srv.upgrades).toBe(2);
    expect(wsSessionState(s).lastMode).toBe("ws_full");
  });

  test("aborting a turn closes the socket", async () => {
    srv = await startFakeOpenAIWs([{ text: "x", delayMs: 3000 } as FakeWsTurnSpec]);
    const ctl = new AbortController();
    const s = sid();
    const p = collect(new OpenAIResponsesAdapter({ ws: FORCE }).stream(request(model("openai", srv.url), [userMsg("hi")], { sessionId: s, signal: ctl.signal }))).catch((e) => e);
    await Bun.sleep(100);
    ctl.abort();
    const err: any = await p;
    expect(err.retryable).toBe(false);
    await Bun.sleep(50);
    expect(srv.open()).toBe(0);
  });
});

describe("Azure fallbacks", () => {
  test("400 model_not_found goes to HTTP and stays there", async () => {
    srv = await startFakeOpenAIWs([{ wsError: { status: 400, code: "model_not_found", message: "no such deployment" } } as FakeWsTurnSpec],
      { httpScript: [{ text: "h1" }, { text: "h2" }] });
    const s = sid();
    const a = new OpenAIResponsesAdapter({ ws: { ...FORCE, azure: true } });
    const m = model("openai", srv.url);
    expect((await turn(a, request(m, [userMsg("1")], { sessionId: s }))).d.content).toEqual([{ type: "text", text: "h1" }]);
    expect((await turn(a, request(m, [userMsg("2")], { sessionId: s }))).d.content).toEqual([{ type: "text", text: "h2" }]);
    expect(srv.upgrades).toBe(1);
  });

  test("403 with the different-inference-provider message goes to HTTP", async () => {
    srv = await startFakeOpenAIWs(
      [{ wsError: { status: 403, code: "forbidden", message: "This model must be called through a different inference provider." } } as FakeWsTurnSpec],
      { httpScript: [{ text: "h1" }] });
    const s = sid();
    const { d } = await turn(new OpenAIResponsesAdapter({ ws: { ...FORCE, azure: true } }), request(model("openai", srv.url), [userMsg("1")], { sessionId: s }));
    expect(d.content).toEqual([{ type: "text", text: "h1" }]);
    expect(wsSessionState(s).disabled).toBe(true);
  });

  test("without azure the same error is an ordinary error", async () => {
    srv = await startFakeOpenAIWs([{ wsError: { status: 400, code: "model_not_found", message: "no such model" } } as FakeWsTurnSpec], { httpScript: [{ text: "h1" }] });
    const err: any = await collect(new OpenAIResponsesAdapter({ ws: { ...FORCE, azure: false } }).stream(request(model("openai", srv.url), [userMsg("1")], { sessionId: sid() }))).catch((e) => e);
    expect(err.kind).toBe("rejected");
    expect(srv.httpRequests.length).toBe(0);
  });
});

describe("when the WebSocket is used", () => {
  const base = (extra: object = {}) => model("openai", "https://api.openai.com/v1", extra);
  test("only for a plain-key openai model on OpenAI's own base URL", () => {
    expect(wsEligible(base(), { mode: "auto" })).toBe(true);
    expect(wsEligible(base({ baseUrl: "https://api.openai.com/v1/" }), { mode: "auto" })).toBe(true);
    expect(wsEligible(model("openai", "https://api.openai.com/v1", { apiKey: undefined }), { mode: "auto" })).toBe(false);
    expect(wsEligible(model("openai", "https://example.com/v1"), { mode: "auto" })).toBe(false);
    expect(wsEligible(model("openai", "https://x.openai.azure.com/openai/v1/"), { mode: "auto" })).toBe(false);
    expect(wsEligible(model("generic-chat-completion-api", "https://api.openai.com/v1"), { mode: "auto" })).toBe(false);
    expect(wsEligible(model("anthropic", "https://api.openai.com/v1"), { mode: "auto" })).toBe(false);
    expect(wsEligible(base({ bedrock: { awsRegion: "us-east-1" } }), { mode: "auto" })).toBe(false);
    expect(wsEligible(base(), { mode: "off" })).toBe(false);
  });

  test("an ineligible model uses HTTP only", async () => {
    srv = await startFakeOpenAIWs([], { httpScript: [{ text: "plain http" }] });
    const { d } = await turn(new OpenAIResponsesAdapter({ ws: { mode: "auto" } }), request(model("openai", srv.url), [userMsg("hi")], { sessionId: sid() }));
    expect(d.content).toEqual([{ type: "text", text: "plain http" }]);
    expect(srv.upgrades).toBe(0);
  });
});

describe("request fields", () => {
  test("prompt_cache_key is cacheKey, else the session id", () => {
    const m = model("openai", "http://x");
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { cacheKey: "shared-key" })).prompt_cache_key).toBe("shared-key");
    expect(buildOpenAIBody(request(m, [userMsg("hi")])).prompt_cache_key).toBe("sess-123");
  });

  test("effort none: left out by default, sent as {effort:none} when the profile says the model accepts it, and on Bedrock", () => {
    const m = model("openai", "http://x");
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { reasoningEffort: "none" })).reasoning).toBeUndefined();
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { reasoningEffort: "none", openai: { acceptsNone: true } })).reasoning).toEqual({ effort: "none" });
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { reasoningEffort: "off", openai: { acceptsNone: true } })).reasoning).toBeUndefined();
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { reasoningEffort: "dynamic", openai: { acceptsNone: true } })).reasoning).toBeUndefined();
    const b = model("openai", "http://x", { bedrock: { awsRegion: "us-east-1" } });
    expect(buildOpenAIBody(request(b, [userMsg("hi")], { reasoningEffort: "none" })).reasoning).toEqual({ effort: "none" });
    expect(buildOpenAIBody(request(m, [userMsg("hi")], { reasoningEffort: "high" })).reasoning).toEqual({ effort: "high", summary: "auto" });
  });
});
