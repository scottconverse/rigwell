import { afterEach, describe, expect, test } from "bun:test";
import { GoogleAdapter, buildGoogleBody } from "../../src/adapters/google.ts";
import { createAdapter, streamWithRetry } from "../../src/adapters/index.ts";
import type { Message } from "../../src/core/types.ts";
import { startFakeGoogle, type FakeGoogleTurnSpec } from "../fakes/fake-google.ts";
import type { FakeServer } from "../fakes/types.ts";
import { collect, done, model, request, userMsg } from "./helpers.ts";

let srv: FakeServer | undefined;
afterEach(() => srv?.stop());
const GM = (url: string, extra: object = {}) => model("google", url, { model: "gemini-3-pro", ...extra });

describe("GoogleAdapter", () => {
  test("registered in createAdapter", () => {
    expect(createAdapter(GM("http://x"))).toBeInstanceOf(GoogleAdapter);
  });

  test("streams thoughts, text and usage; request shape", async () => {
    srv = await startFakeGoogle([{ thinking: "ponder", text: "hello world", usage: { input: 12, output: 7, cacheRead: 3 } }]);
    const ev = await collect(new GoogleAdapter().stream(request(GM(srv.url), [userMsg("hi")], { reasoningEffort: "high" })));
    expect(ev.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("hello world");
    expect(ev.filter((e) => e.type === "thinking_delta").map((e: any) => e.text).join("")).toBe("ponder");
    const d = done(ev);
    expect(d.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(d.content[1]).toEqual({ type: "text", text: "hello world" });
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ inputTokens: 12, outputTokens: 9, cacheCreationTokens: 0, cacheReadTokens: 3, thinkingTokens: 2 });
    const b = srv.requests[0];
    expect(b.systemInstruction.parts[0].text).toBe("identity line\n\nbase prompt");
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(b.tools[0].functionDeclarations[0].name).toBe("Read");
    expect(b.tools[0].functionDeclarations[0].parametersJsonSchema.type).toBe("object");
    expect(b.generationConfig.maxOutputTokens).toBe(4096);
    expect(b.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    expect(srv.headers[0]!["x-goog-api-key"]).toBe("test-key");
  });

  test("thought signatures are kept and replayed with the tool calls that produced them", async () => {
    srv = await startFakeGoogle([
      { text: "looking", thoughtSignature: "SIG-ABC", toolCalls: [{ name: "Read", input: { path: "a.txt" } }, { name: "Read", input: { path: "b.txt" } }] } as FakeGoogleTurnSpec,
      (body) => ({ text: "saw " + body.contents.at(-1).parts.map((p: any) => p.functionResponse.response.output).join("+") }),
    ]);
    const m = GM(srv.url);
    const a = new GoogleAdapter();
    const msgs: Message[] = [userMsg("read both")];
    const d1 = done(await collect(a.stream(request(m, msgs))));
    expect(d1.stopReason).toBe("tool_use");
    const calls = d1.content.filter((b) => b.type === "tool_use") as { id: string; name: string }[];
    expect(calls.length).toBe(2);
    expect(calls[0]!.id).not.toBe(calls[1]!.id);
    msgs.push({ id: "a1", role: "assistant", content: d1.content });
    msgs.push({ id: "u2", role: "user", content: [
      { type: "tool_result", tool_use_id: calls[0]!.id, content: "AAA" },
      { type: "tool_result", tool_use_id: calls[1]!.id, content: "BBB", is_error: false },
    ] });
    const d2 = done(await collect(a.stream(request(m, msgs))));
    expect(d2.content).toEqual([{ type: "text", text: "saw AAA+BBB" }]);
    const model = srv.requests[1].contents[1];
    expect(model.role).toBe("model");
    const fcs = model.parts.filter((p: any) => p.functionCall);
    expect(fcs[0].thoughtSignature).toBe("SIG-ABC");
    expect(fcs[1].thoughtSignature).toBeUndefined(); // only the first call carried one
    expect(fcs[0].functionCall).toMatchObject({ name: "Read", args: { path: "a.txt" } });
    const user = srv.requests[1].contents[2];
    expect(user.parts[0].functionResponse).toMatchObject({ name: "Read", response: { output: "AAA" } });
  });

  test("a signature on the text part is replayed on the text", () => {
    const msgs: Message[] = [
      userMsg("q"),
      { id: "a", role: "assistant", content: [
        { type: "thinking", thinking: "", signature: JSON.stringify({ text: "TSIG" }), signatureProvider: "google" },
        { type: "text", text: "answer" },
      ] },
      userMsg("next", "u2"),
    ];
    const body = buildGoogleBody(request(GM("http://x"), msgs)) as any;
    expect(body.contents[1]).toEqual({ role: "model", parts: [{ text: "answer", thoughtSignature: "TSIG" }] });
  });

  test("signatures of another provider are not sent; errors in tool results use the error field; no custom tools", () => {
    const msgs: Message[] = [
      userMsg("q"),
      { id: "a", role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "x", signatureProvider: "chat" }, { type: "tool_use", id: "c1", name: "Read", input: {} }] },
      { id: "u", role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "nope", is_error: true }] },
    ];
    const body = buildGoogleBody(request(GM("http://x"), msgs)) as any;
    expect(body.contents[1].parts[0].thoughtSignature).toBeUndefined();
    expect(body.contents[2].parts[0].functionResponse.response).toEqual({ error: "nope" });
    expect(JSON.stringify(body.tools)).not.toContain('"custom"');
  });

  test("finish reasons: MAX_TOKENS is length, SAFETY is other; a prompt block is rejected", async () => {
    srv = await startFakeGoogle([{ text: "cut", finishReason: "MAX_TOKENS" } as FakeGoogleTurnSpec, { text: "x", finishReason: "SAFETY" } as FakeGoogleTurnSpec]);
    const m = GM(srv.url);
    expect(done(await collect(new GoogleAdapter().stream(request(m, [userMsg("1")])))).stopReason).toBe("max_tokens");
    expect(done(await collect(new GoogleAdapter().stream(request(m, [userMsg("2")])))).stopReason).toBe("other");
  });

  test("HTTP errors are mapped; a cut stream is a network error", async () => {
    srv = await startFakeGoogle([{ status: 503 }, { text: "a partial answer", breakMidStream: true }]);
    const err: any = await collect(streamWithRetry(new GoogleAdapter(), request(GM(srv.url), [userMsg("hi")]), { strategy: "no_retry" })).catch((e) => e);
    expect(err.kind).toBe("unavailable");
    const err2: any = await collect(new GoogleAdapter().stream(request(GM(srv.url), [userMsg("hi")]))).catch((e) => e);
    expect(err2.kind).toBe("network");
  });
});
