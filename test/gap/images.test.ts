// Images and files: Read returns image blocks; Anthropic and OpenAI bodies carry them; noImageSupport; Script image().
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnthropicBody } from "../../src/adapters/anthropic.ts";
import { buildOpenAIBody } from "../../src/adapters/openai.ts";
import { createReadTool } from "../../src/tools/read.ts";
import type { ModelConfig } from "../../src/core/types.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { driver } from "./helpers.ts";
import { call, makeStubSession, text, MODEL } from "../agent/helpers.ts";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ctx = (cwd: string, extra: Record<string, unknown> = {}): any => ({ cwd, sessionId: "s", readFiles: new Map(), signal: new AbortController().signal, ...extra });

describe("Read of an image", () => {
  test("PNG, JPEG, GIF and WebP come back as image blocks; fake bytes and unsupported models are refused", async () => {
    const d = mkdtempSync(join(tmpdir(), "rigwell-img-"));
    writeFileSync(join(d, "a.png"), PNG);
    writeFileSync(join(d, "b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]));
    writeFileSync(join(d, "c.gif"), Buffer.from("GIF89a....."));
    writeFileSync(join(d, "d.webp"), Buffer.from("RIFF....WEBPVP8 "));
    writeFileSync(join(d, "fake.png"), "not an image");
    const read = createReadTool();
    const types: string[] = [];
    for (const f of ["a.png", "b.jpg", "c.gif", "d.webp"]) {
      const r = await read.run({ path: f }, ctx(d));
      expect(r.isError).toBeFalsy();
      types.push(r.images![0]!.mediaType);
    }
    expect(types).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect((await read.run({ path: "a.png" }, ctx(d))).images![0]!.data).toBe(PNG.toString("base64"));
    expect((await read.run({ path: "fake.png" }, ctx(d))).isError).toBe(true);
    expect((await read.run({ path: "a.png" }, ctx(d, { imagesSupported: false }))).content).toContain("cannot look at images");
  });
  test("lineNumbers follows the profile (always) unless the call says false", async () => {
    const d = mkdtempSync(join(tmpdir(), "rigwell-ln-"));
    writeFileSync(join(d, "t.txt"), "x\ny\n");
    const read = createReadTool();
    expect((await read.run({ path: "t.txt" }, ctx(d))).content).not.toMatch(/^\s+1\t/);
    expect((await read.run({ path: "t.txt" }, ctx(d, { readLineNumbers: "always" }))).content).toMatch(/^\s+1\tx/);
    expect((await read.run({ path: "t.txt", lineNumbers: false }, ctx(d, { readLineNumbers: "always" }))).content).not.toMatch(/^\s+1\t/);
  });
});

const model = (p: "anthropic" | "openai"): ModelConfig => ({ id: "m", model: "m", displayName: "m", provider: p, baseUrl: "http://x" });
const imgMsg: any[] = [
  { id: "u1", role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "AAAA" }, { type: "document", mediaType: "application/pdf", data: "BBBB", name: "spec.pdf" }] },
  { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x.png" } }] },
  { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "an image", images: [{ type: "image", mediaType: "image/jpeg", data: "CCCC" }] }] },
];

describe("wire formats", () => {
  test("Anthropic: image and document blocks, tool_result with an image", () => {
    const body: any = buildAnthropicBody({ model: model("anthropic"), sessionId: "s", system: [], tools: [], messages: imgMsg, maxOutputTokens: 100 });
    expect(body.messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(body.messages[0].content[2]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBBB" }, title: "spec.pdf" });
    const tr = body.messages[2].content[0];
    expect(tr.content[0]).toEqual({ type: "text", text: "an image" });
    expect(tr.content[1].source.media_type).toBe("image/jpeg");
  });
  test("OpenAI: input_image, input_file and a function_call_output with an image", () => {
    const body: any = buildOpenAIBody({ model: model("openai"), sessionId: "s", system: [], tools: [], messages: imgMsg, maxOutputTokens: 100 });
    const user = body.input[0].content;
    expect(user[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
    expect(user[2]).toEqual({ type: "input_file", filename: "spec.pdf", file_data: "data:application/pdf;base64,BBBB" });
    const out = body.input.find((i: any) => i.type === "function_call_output");
    expect(out.output[0]).toEqual({ type: "input_text", text: "an image" });
    expect(out.output[1].image_url).toBe("data:image/jpeg;base64,CCCC");
  });
  test("cache strategy none sends no cache_control", () => {
    const body: any = buildAnthropicBody({ model: model("anthropic"), sessionId: "s", system: ["a"], tools: [], messages: imgMsg, maxOutputTokens: 100, cacheStrategy: "none" });
    expect(JSON.stringify(body)).not.toContain("cache_control");
    const withCache: any = buildAnthropicBody({ model: model("anthropic"), sessionId: "s", system: ["a"], tools: [], messages: imgMsg, maxOutputTokens: 100 });
    expect(JSON.stringify(withCache)).toContain("cache_control");
  });
});

describe("through a session", () => {
  test("the model is sent the image Read returned; a model without image support gets a note instead", async () => {
    const d = mkdtempSync(join(tmpdir(), "rigwell-img-"));
    const respond = (_r: any, n: number) => (n === 0 ? call("Read", { path: "p.png" }, "r1") : text("seen"));
    const a = makeStubSession(respond);
    writeFileSync(join(a.cwd, "p.png"), PNG);
    a.session.addUserMessage("what is it");
    await a.session.settled();
    const tr = a.requests[1]!.messages.at(-1)!.content[0] as any;
    expect(tr.images?.[0]?.mediaType).toBe("image/png");
    const body: any = buildAnthropicBody(a.requests[1]!);
    expect(JSON.stringify(body.messages.at(-1))).toContain('"type":"image"');

    const noImg = { ...MODEL, noImageSupport: true };
    const b = makeStubSession(respond, { resolveModel: () => noImg });
    writeFileSync(join(b.cwd, "p.png"), PNG);
    b.session.addUserMessage("what is it");
    await b.session.settled();
    expect(JSON.stringify(b.requests[0]!.tools)).toBeTruthy();
    expect(JSON.stringify(b.requests[1]!.messages.at(-1))).toContain("cannot look at images");
    expect(JSON.stringify(b.requests[1]!.messages.at(-1))).not.toContain('"images"');
    void d;
  });

  test("Script image() attaches the image to the Script result", async () => {
    const code = `image("${PNG.toString("base64")}", "image/png"); print("drawn");`;
    const s = makeStubSession((_r, n) => (n === 0 ? call("Script", { script: code }, "s1") : text("ok")));
    s.session.addUserMessage("draw");
    await s.session.settled();
    const tr = s.requests[1]!.messages.at(-1)!.content[0] as any;
    expect(tr.images?.length).toBe(1);
    expect(tr.content).toContain("image 1 attached");
  }, 20000);
});

describe("attachments over the protocol", () => {
  test("images, a PDF and a text file reach Anthropic and OpenAI request bodies", async () => {
    const anth = await startFakeAnthropic([{ text: "ok" }]);
    const oai = await startFakeOpenAI([{ text: "ok" }]);
    try {
      for (const [srv, provider] of [[anth, "anthropic"], [oai, "openai"]] as const) {
        process.env.RIGWELL_HOME = makeHome([{ provider, url: srv.url, displayName: "F" }]);
        const d = driver({ canPrompt: false });
        await d.call("initialize_session", { cwd: makeRepo(), modelId: "custom:F-0" });
        await d.turn("see these", {
          images: [{ type: "base64", data: PNG.toString("base64"), mediaType: "image/png" }],
          files: [{ type: "base64", mediaType: "application/pdf", data: "JVBERi0=", name: "a.pdf" }, { type: "text", mediaType: "text/plain", data: "notes body", name: "n.txt" }],
        });
        const s = JSON.stringify(srv.requests[0]);
        expect(s).toContain(provider === "anthropic" ? '"media_type":"image/png"' : "data:image/png;base64");
        expect(s).toContain(provider === "anthropic" ? '"type":"document"' : '"type":"input_file"');
        expect(s).toContain("notes body");
        await d.call("close_session", {});
      }
    } finally { anth.stop(); oai.stop(); }
  }, 30000);

  test("bad attachments are invalid params", async () => {
    const anth = await startFakeAnthropic([{ text: "ok" }]);
    process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: anth.url, displayName: "F" }]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: makeRepo(), modelId: "custom:F-0" });
    await expect(d.call("add_user_message", { text: "x", images: [{ type: "base64", data: "AA", mediaType: "image/bmp" }] })).rejects.toThrow(/mediaType/);
    await expect(d.call("add_user_message", { text: "x", files: [{ type: "base64", mediaType: "application/zip", data: "AA" }] })).rejects.toThrow(/files must be/);
    await expect(d.call("add_user_message", { content: [] })).rejects.toThrow(/non-empty/);
    await expect(d.call("add_user_message", { text: "x", queuePlacement: "later" })).rejects.toThrow(/queuePlacement/);
    // content[] works in place of text
    await d.turn("", { content: [{ type: "text", text: "from content" }, { type: "image", data: PNG.toString("base64"), mediaType: "image/png" }], text: undefined });
    expect(JSON.stringify(anth.requests[0])).toContain("from content");
    await d.call("close_session", {});
    anth.stop();
  }, 30000);
});
