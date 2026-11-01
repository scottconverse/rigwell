// Phase 4: compaction (spec 4.4): trigger, summarizer request shape, the next request, the record, load after compaction.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSession, loadTranscript } from "../../src/storage/transcript.ts";
import { readSessionSettings } from "../../src/storage/session-settings.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { inproc } from "./inproc.ts";
import { makeRepo } from "./helpers.ts";
import type { Tool } from "../../src/core/types.ts";

const servers: FakeServer[] = [];
const prevHome = process.env.RIGWELL_HOME;
afterAll(() => {
  servers.forEach((s) => s.stop());
  if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
});

const SUMMARY = "## 1. User requests\n- Read the big file (done).\n## 7. Next step\nNone.";
const isSummarizer = (body: any) => JSON.stringify(body.system ?? "").includes("handoff summary");
const sys = (b: any) => JSON.stringify(b.system);
const toolsJson = (b: any) => JSON.stringify(b.tools);

interface Opts { settings?: Record<string, unknown>; model?: Record<string, unknown>; provider?: "anthropic" | "openai"; extraModels?: Record<string, unknown>[] }

async function setup(script: FakeTurn[], o: Opts = {}) {
  const server = await (o.provider === "openai" ? startFakeOpenAI : startFakeAnthropic)(script);
  servers.push(server);
  const repo = makeRepo();
  writeFileSync(join(repo, "big.txt"), Array.from({ length: 600 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n") + "\n");
  const home = mkdtempSync(join(tmpdir(), "rigwell-compact-home-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    customModels: [{ model: "fake-model", displayName: "Fake", provider: o.provider ?? "anthropic", baseUrl: server.url, apiKey: "test-key-not-real", ...o.model }, ...(o.extraModels ?? [])],
    compactionTokenLimit: 9000,
    ...o.settings,
  }));
  process.env.RIGWELL_HOME = home;
  const c = inproc();
  const r = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: "custom:Fake-0", toolExecutionMode: "direct_only", autonomyLevel: "low" });
  return { server, repo, home, c, sessionId: r.sessionId as string };
}

describe("compaction", () => {
  test("a small compactionTokenLimit triggers it; summarizer request shape; next request opens with the preamble", async () => {
    const script: FakeTurn[] = [
      // turn 1: read the big file; the reported context size is already near the limit
      () => ({ toolCalls: [{ name: "Read", input: { path: "big.txt" } }], usage: { input: 7000 } }),
      () => ({ text: SUMMARY }), // the summarizer
      () => ({ text: "Done after compaction." }),
    ];
    const s = await setup(script);
    await s.c.turn("Please read big.txt and tell me what it says.");
    expect(s.c.notes().filter((n) => n.type === "agent_turn_completed").at(-1).reason).toBe("completed");
    expect(s.server.requests.length).toBe(3);
    const [first, summ, after] = s.server.requests;

    // summarizer: one system block, no tools, one user message with the transcript in a fence
    expect(isSummarizer(summ)).toBe(true);
    expect(summ.tools).toBeUndefined();
    expect(summ.system.length).toBe(1);
    expect(summ.system[0].text).toContain("Aim for about 4000 tokens");
    expect(summ.messages.length).toBe(1);
    const user = summ.messages[0].content[0].text as string;
    expect(user.startsWith("Write the handoff summary for the conversation below")).toBe(true);
    expect(user).toMatch(/\n```conversation\n/);
    expect(user).toContain("Please read big.txt and tell me what it says.");
    expect(user).toContain("[environment block omitted at compaction boundary,");
    expect(user).toContain("[session block omitted at compaction boundary,");
    expect(user).toContain("[tool call Read]");
    expect(user).toContain("characters cut"); // the 20 KB tool result is capped
    expect(user).not.toContain("<environment>");
    expect(summ.max_tokens).toBe(16_192); // custom model, no maxOutputTokens: 8,000 cap + 8,192 headroom

    // the next request: same system and tools, then the preamble with the summary and the re-injected context
    expect(sys(after)).toBe(sys(first));
    expect(toolsJson(after)).toBe(toolsJson(first));
    expect(after.messages.length).toBe(1);
    const blocks = after.messages[0].content.map((b: any) => b.text as string);
    expect(blocks[0]).toContain("This session continues from an earlier conversation that ran out of context.");
    expect(blocks[0]).toContain("<summary>\n" + SUMMARY + "\n</summary>");
    expect(blocks.some((b: string) => b.startsWith("<environment>"))).toBe(true);
    expect(blocks.some((b: string) => b.startsWith("<session>"))).toBe(true);
    expect(blocks.some((b: string) => b.startsWith("<todos>"))).toBe(true);
    // breakpoints: system, skills/todos area, newest user message: never more than four
    expect(JSON.stringify(after).match(/cache_control/g)!.length).toBeLessThanOrEqual(4);

    // record, notification, state
    const n = s.c.notes().find((x) => x.type === "session_compacted");
    expect(n.removedCount).toBeGreaterThan(0);
    expect(n.visibleBoundaryMessageId).toBeNull(); // nothing kept verbatim: the only turn is summarized
    const file = findSession(s.sessionId, s.repo)!;
    const rec = loadTranscript(file).compaction!;
    expect(rec.summaryText).toBe(SUMMARY);
    expect(rec.summaryTokens).toBeGreaterThan(0);
    expect(rec.summaryKind).toBe("llm_summary");
    expect(rec.reason).toBe("automatic");
    expect(rec.id).toBe(n.summaryId);
    expect(rec.anchorMessage.id.length).toBeGreaterThan(0);
    expect(rec.loadedDeferredToolNames).toEqual([]);
    expect(readFileSync(file.transcriptPath, "utf8")).toContain('"type":"compaction_state"');
    // the cache monitor names the cause
    const stats = await s.c.call("get_context_stats", {});
    expect(stats.cache.divergences.some((d: any) => d.cause === "compaction")).toBe(true);
    expect(s.c.notes().some((x) => x.type === "agent_working_state_changed" && x.newState === "compacting_conversation")).toBe(true);
  }, 30_000);

  test("recent turn is kept verbatim after the preamble; load_session rebuilds from the record; loaded deferred tools survive", async () => {
    const deferredTool: Tool = {
      name: "weather_lookup", description: "Looks up the weather.", category: "read",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      run: async (i) => ({ content: `sunny in ${i.city}` }),
    };
    const script: FakeTurn[] = [
      () => ({ toolCalls: [{ name: "load_tools", input: { names: ["weather_lookup"] } }], usage: { input: 500 } }),
      () => ({ text: "Loaded the weather tool.", usage: { input: 800 } }),
      // turn 2: the reported size is over the limit before the second call
      () => ({ toolCalls: [{ name: "Read", input: { path: "greet.js" } }], usage: { input: 9500 } }),
      () => ({ text: SUMMARY }),
      () => ({ text: "Second turn done.", usage: { input: 700 } }),
      // after load_session, a third turn that uses the tool without loading it again
      () => ({ toolCalls: [{ name: "call_tool", input: { name: "weather_lookup", args: { city: "Oslo" } } }] }),
      () => ({ text: "It is sunny in Oslo." }),
    ];
    const s = await setup(script);
    s.c.conn.session!.registerDeferredTool(deferredTool);
    await s.c.turn("first: load the weather tool");
    await s.c.turn("second: read greet.js");
    const [, , , summ, after] = s.server.requests.slice(0, 5);

    // turn 1 is summarized, turn 2 (from its prompt on) is kept verbatim
    const user = summ.messages[0].content[0].text as string;
    expect(user).toContain("first: load the weather tool");
    expect(user).not.toContain("second: read greet.js");
    const texts = after.messages.map((m: any) => m.content.map((b: any) => b.text ?? b.content ?? b.name ?? "").join("|"));
    expect(texts[0]).toContain("This session continues from an earlier conversation");
    expect(texts[0]).toContain("weather_lookup({ city: string })"); // the loaded tool is re-announced with its signature
    expect(texts[0]).toContain("Tools loaded earlier in this session (still loaded)");
    expect(texts[1]).toBe("second: read greet.js");
    expect(after.messages.length).toBe(4); // preamble, prompt, assistant tool call, tool result
    const note = s.c.notes().find((x) => x.type === "session_compacted");
    expect(note.visibleBoundaryMessageId).not.toBeNull();

    const rec = loadTranscript(findSession(s.sessionId, s.repo)!).compaction!;
    expect(rec.loadedDeferredToolNames).toEqual(["weather_lookup"]);
    expect(readSessionSettings(findSession(s.sessionId, s.repo)!)!.loadedDeferredToolNames).toEqual(["weather_lookup"]);
    await s.c.call("close_session", { reason: "other" });

    // resume in a new connection
    const b = inproc();
    const loaded = await b.call("load_session", { sessionId: s.sessionId, cwd: s.repo });
    const view = b.conn.session!.messages;
    expect(view[0].id.startsWith("context-compact-")).toBe(true);
    expect(view[1].content[0]).toEqual({ type: "text", text: "second: read greet.js" });
    // the UI still gets the whole conversation (the preamble itself is llm_only)
    const uiText = JSON.stringify(loaded.session.messages);
    expect(uiText).toContain("first: load the weather tool");
    expect(uiText).toContain("second: read greet.js");
    expect(uiText).not.toContain("This session continues");
    expect(b.conn.session!.deferred.loadedNames()).toEqual(["weather_lookup"]);
    b.conn.session!.registerDeferredTool(deferredTool);
    await b.turn("third: weather in Oslo?");
    const req = s.server.requests[5];
    expect(JSON.stringify(req.messages[0])).toContain("This session continues from an earlier conversation");
    expect(sys(req)).toBe(sys(after));
    expect(toolsJson(req)).toBe(toolsJson(after));
    expect(JSON.stringify(s.server.requests[6])).toContain("sunny in Oslo");
  }, 30_000);

  test("manual compact_session returns { newSessionId, removedCount }, compacts in place, accepts custom instructions; mode handoff keeps nothing", async () => {
    const script: FakeTurn[] = [
      { text: "Turn one answer." }, { text: "Turn two answer." },
      { text: SUMMARY }, // manual
      { text: "Turn three answer." },
      { text: "HANDOFF " + SUMMARY },
    ];
    const s = await setup(script, { settings: { compactionTokenLimit: 1_000_000 } });
    await s.c.turn("one");
    await s.c.turn("two");
    const r = await s.c.call("compact_session", { customInstructions: "Focus on file paths." });
    expect(r.newSessionId).toBe(s.sessionId);
    expect(r.removedCount).toBeGreaterThan(0);
    const summ = s.server.requests[2];
    expect(isSummarizer(summ)).toBe(true);
    expect(summ.messages[0].content[0].text).toContain("Additional instructions from the user for this summary:\nFocus on file paths.");
    expect(summ.messages[0].content[0].text).toContain("one");
    expect(summ.messages[0].content[0].text).not.toContain("[user]\ntwo"); // turn two is kept verbatim
    await s.c.turn("three");
    const next = s.server.requests[3];
    expect(next.messages.map((m: any) => m.content[0].text ?? "").slice(0, 3).map((t: string) => t.slice(0, 22))).toEqual(["This session continues", "two", "Turn two answer."]);
    const h = await s.c.call("compact_session", { mode: "handoff" });
    expect(h.removedCount).toBeGreaterThan(0);
    expect(s.c.conn.session!.messages.length).toBe(1); // only the preamble
    expect(loadTranscript(findSession(s.sessionId, s.repo)!).compaction!.reason).toBe("manual");
    await expect(s.c.call("compact_session", { mode: "bogus" })).rejects.toThrow();
  }, 30_000);

  test("summarizer max_tokens chain: maxOutputTokens 5000 clamps to 5000; logged", async () => {
    const logs: string[] = [];
    const s = await setup([{ text: "a" }, { text: "b" }, { text: SUMMARY }], { model: { maxOutputTokens: 5000 }, settings: { compactionTokenLimit: 1_000_000 } });
    s.c.conn.session!["deps"].log = (m: string) => logs.push(m);
    await s.c.turn("one");
    await s.c.turn("two");
    await s.c.call("compact_session", {});
    expect(s.server.requests[2].max_tokens).toBe(5000);
    expect(logs.some((l) => l.includes("summarizer limit 5000 tokens, max_tokens 5000"))).toBe(true);
  }, 30_000);

  test("compaction model setting: the summarizer runs on the named model", async () => {
    const other = await startFakeAnthropic([{ text: SUMMARY }]);
    servers.push(other);
    const s = await setup([{ text: "a" }, { text: "b" }], {
      settings: { compactionTokenLimit: 1_000_000 },
      extraModels: [{ model: "fake-small", displayName: "Small", provider: "anthropic", baseUrl: other.url, apiKey: "test-key-not-real" }],
    });
    await s.c.turn("one");
    await s.c.turn("two");
    await s.c.call("update_session_settings", { compactionModelId: "custom:Small-1" });
    await s.c.call("compact_session", {});
    expect(other.requests.length).toBe(1);
    expect(other.requests[0].model).toBe("fake-small");
    expect(s.server.requests.length).toBe(2);
    expect(readSessionSettings(findSession(s.sessionId, s.repo)!)!.compactionModelId).toBe("custom:Small-1");
    await expect(s.c.call("update_session_settings", { compactionModelId: "custom:Nope-9" })).rejects.toThrow();
  }, 30_000);

  test("works on the OpenAI wire too (summarizer has no tools, one input message)", async () => {
    const s = await setup([
      () => ({ toolCalls: [{ name: "Read", input: { path: "big.txt" } }], usage: { input: 7000 } }),
      () => ({ text: SUMMARY }),
      () => ({ text: "Done." }),
    ], { provider: "openai" });
    await s.c.turn("Please read big.txt.");
    const [first, summ, after] = s.server.requests;
    expect(summ.tools).toEqual([]);
    expect(summ.input.length).toBe(1);
    expect(summ.instructions).toContain("handoff summary");
    expect(after.instructions).toBe(first.instructions);
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(after.input[0])).toContain("This session continues from an earlier conversation");
  }, 30_000);

  test("a transcript with a backtick run gets a longer fence", async () => {
    const { fenceFor } = await import("../../src/agent/compaction.ts");
    expect(fenceFor("no ticks")).toBe("```");
    expect(fenceFor("a ```` b")).toBe("`````");
  });

  test("nothing to compact yet returns an error, and a failed summary leaves the history as it was", async () => {
    const s = await setup([{ text: "ok" }], { settings: { compactionTokenLimit: 1_000_000 } });
    await expect(s.c.call("compact_session", {})).rejects.toThrow(/Nothing to compact/);
    await s.c.turn("one");
    const before = s.c.conn.session!.messages.length;
    await expect(s.c.call("compact_session", {})).rejects.toThrow(); // script exhausted: the summarizer fails
    expect(s.c.conn.session!.messages.length).toBe(before);
    expect(loadTranscript(findSession(s.sessionId, s.repo)!).compaction).toBeUndefined();
  }, 60_000);
});
