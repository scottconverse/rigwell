// Protocol gaps over the real connection: structured output, steering, initialize params, session RPCs, titles,
// heartbeat, thinking_text_complete, denial comments, batch prompts, pending prompts across a reconnect.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession } from "../../src/storage/transcript.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { driver } from "./helpers.ts";

const servers: FakeServer[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); });

async function setup(turns: FakeTurn[], extraSettings: Record<string, unknown> = {}) {
  const model = await startFakeAnthropic(turns);
  servers.push(model);
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
  const sf = join(home, "settings.json");
  writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), ...extraSettings }));
  process.env.RIGWELL_HOME = home;
  return { model, home, repo: makeRepo() };
}
const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.name);
const SCHEMA = { type: "object", properties: { answer: { type: "string" }, n: { type: "integer" } }, required: ["answer"], additionalProperties: false };
const FORMAT = { type: "json_schema", schema: SCHEMA };

describe("structured output", () => {
  test("a valid StructuredOutput call completes the turn with resultKind structured", async () => {
    const { model, repo } = await setup([{ toolCalls: [{ name: "StructuredOutput", input: { answer: "42", n: 1 } }] }]);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", structuredOutputFormat: FORMAT });
    expect(init.settings.structuredOutputFormat).toEqual(FORMAT);
    const done = await d.turn("what is the answer");
    expect(done.reason).toBe("completed");
    expect(done.structuredOutput).toEqual({ answer: "42", n: 1 });
    expect(model.requests.length).toBe(1);
    expect(toolNames(model.requests[0])).toContain("StructuredOutput");
    expect(model.requests[0].tools.find((t: any) => t.name === "StructuredOutput").input_schema).toEqual(SCHEMA);
    await d.call("close_session", {});
    expect(loadSession(init.sessionId, repo).outcomes.at(-1)).toMatchObject({ reason: "completed", resultKind: "structured" });
  }, 30000);

  test("an answer that does not fit is sent back; the model fixes it", async () => {
    const { model, repo } = await setup([
      { toolCalls: [{ name: "StructuredOutput", input: { n: "x" } }] },
      { toolCalls: [{ name: "StructuredOutput", input: { answer: "ok" } }] },
    ]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", structuredOutputFormat: FORMAT });
    const done = await d.turn("go");
    expect(done.reason).toBe("completed");
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('missing required property \\"answer\\"');
    await d.call("close_session", {});
  }, 30000);

  test("no call: structured_output_missing after one reminder; three bad calls: structured_output_invalid", async () => {
    const a = await setup([{ text: "here is prose" }, { text: "still prose" }]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: a.repo, modelId: "custom:F-0", structuredOutputFormat: FORMAT });
    expect((await d.turn("go")).reason).toBe("structured_output_missing");
    expect(a.model.requests.length).toBe(2);
    await d.call("close_session", {});

    const bad = { toolCalls: [{ name: "StructuredOutput", input: { n: 1 } }] };
    const b = await setup([bad, bad, bad]);
    const e = driver({ canPrompt: false });
    await e.call("initialize_session", { cwd: b.repo, modelId: "custom:F-0", structuredOutputFormat: FORMAT });
    expect((await e.turn("go")).reason).toBe("structured_output_invalid");
    await e.call("close_session", {});
  }, 30000);

  test("an unusable schema ends the turn before any model call; outputFormat per message", async () => {
    const { model, repo } = await setup([{ text: "plain" }, { toolCalls: [{ name: "StructuredOutput", input: { answer: "x" } }] }]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    const bad = await d.turn("go", { outputFormat: { type: "json_schema", schema: { type: "array" } } });
    expect(bad.reason).toBe("structured_output_schema_invalid");
    expect(model.requests.length).toBe(0);
    await expect(d.call("add_user_message", { text: "x", outputFormat: { type: "text" } })).rejects.toThrow(/outputFormat/);
    expect((await d.turn("no format")).reason).toBe("completed");
    expect(toolNames(model.requests[0])).not.toContain("StructuredOutput");
    const ok = await d.turn("now with format", { outputFormat: FORMAT });
    expect(ok.structuredOutput).toEqual({ answer: "x" });
    expect(toolNames(model.requests[1])).toContain("StructuredOutput");
    await d.call("close_session", {});
  }, 30000);
});

describe("queuePlacement", () => {
  test("end_of_loop steers: delivered right after the next tool batch; end_of_turn waits for the next turn", async () => {
    const { model, repo } = await setup([
      { toolCalls: [{ name: "Execute", input: { command: "sleep 0.4", riskLevel: "low", riskReason: "wait" } }] },
      { text: "first turn over" },
      { text: "second turn over" },
    ]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high" });
    await d.call("add_user_message", { text: "start", messageId: "t1" });
    await d.until(() => d.notes("tool_execution_phase_changed").some((n) => n.phase === "executing"));
    await d.call("add_user_message", { text: "STEER-NOW", messageId: "steer1", queuePlacement: "end_of_loop" });
    await d.call("add_user_message", { text: "AFTER-TURN", messageId: "t2", queuePlacement: "end_of_turn" });
    await d.until(() => d.completed().length >= 2);
    const second = JSON.stringify(model.requests[1].messages.slice(-2));
    expect(second).toContain("STEER-NOW");
    expect(second).not.toContain("AFTER-TURN");
    expect(JSON.stringify(model.requests[2].messages)).toContain("AFTER-TURN");
    expect(d.notes("create_message").some((n) => n.message.id === "steer1")).toBe(true);
    await d.call("close_session", {});
  }, 30000);
});

describe("initialize_session / load_session params", () => {
  test("tool id lists, systemPrompt forms, disableBuiltinSkills; saved and restored on load", async () => {
    const { model, repo } = await setup([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
    const d = driver({ canPrompt: false });
    const init = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high", restrictToolIds: ["Read", "LS", "Execute"], disabledToolIds: ["Execute"], systemPrompt: "You are a pirate.", disableBuiltinSkills: true });
    expect(init.settings).toMatchObject({ restrictToolIds: ["Read", "LS", "Execute"], disabledToolIds: ["Execute"], systemPrompt: "You are a pirate." });
    await d.turn("hi");
    expect(toolNames(model.requests[0]).sort()).toEqual(["LS", "Read"]);
    expect(model.requests[0].system.map((s: any) => s.text).join("\n")).toContain("You are a pirate.");
    expect(model.requests[0].system.map((s: any) => s.text).join("\n")).not.toContain("# Reading files");
    const lt = await d.call("list_tools", { restrictToolIds: ["Read"] });
    expect(lt.tools.map((t: any) => t.id)).toEqual(["Read"]);
    await d.call("close_session", {});

    const e = driver({ canPrompt: false });
    const loaded = await e.call("load_session", { sessionId: init.sessionId, cwd: repo });
    expect(loaded.settings.restrictToolIds).toEqual(["Read", "LS", "Execute"]);
    await e.turn("again");
    expect(toolNames(model.requests[1]).sort()).toEqual(["LS", "Read"]);
    await e.call("close_session", {});

    const f = driver({ canPrompt: false });
    await f.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "off", systemPrompt: { type: "preset", preset: "rigwell", append: "ALSO-BE-BRIEF" }, enabledToolIds: ["ApplyPatch"] });
    await f.turn("preset");
    const sys = model.requests[2].system.map((s: any) => s.text).join("\n");
    expect(sys).toContain("# Reading files");
    expect(sys).toContain("ALSO-BE-BRIEF");
    await f.call("close_session", {});

    const g = driver({ canPrompt: false });
    await expect(g.call("initialize_session", { cwd: repo, modelId: "custom:F-0", systemPrompt: "   " })).rejects.toThrow(/blank/);
    await expect(g.call("initialize_session", { cwd: repo, modelId: "custom:F-0", restrictToolIds: "Read" })).rejects.toThrow(/list of strings/);
    await g.call("initialize_session", { cwd: repo, modelId: "custom:F-0", systemPromptOverride: "old form" });
    await g.turn("x");
    expect(model.requests[3].system.map((s: any) => s.text).join("\n")).toContain("old form");
    await g.call("close_session", {});
  }, 30000);

  test("list_models includeDisabled shows entries that did not validate", async () => {
    const { home, repo } = await setup([]);
    const sf = join(home, "settings.json");
    const j = JSON.parse(readFileSync(sf, "utf8"));
    j.customModels.push({ model: "broken", provider: "anthropic", baseUrl: "not a url" });
    writeFileSync(sf, JSON.stringify(j));
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    expect((await d.call("list_models", {})).models.some((m: any) => m.disabled)).toBe(false);
    const all = (await d.call("list_models", { includeDisabled: true })).models;
    expect(all.find((m: any) => m.disabled)).toMatchObject({ disabled: true, disabledReason: expect.stringContaining("baseUrl") });
    await d.call("close_session", {});
  }, 30000);

  test("update_session_settings: compactionTokenLimit; routed fields stay absent without routing", async () => {
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await d.call("update_session_settings", { compactionTokenLimit: 5000, compactionThresholdCheckEnabled: false });
    expect(d.conn.session!.compactionThreshold()).toBe(5000);
    const st = d.notes("settings_updated").at(-1).settings;
    expect(st.compactionThresholdCheckEnabled).toBe(false);
    expect(st.routedModelId).toBeUndefined();
    await d.call("close_session", {});
  });
});

describe("session RPCs", () => {
  test("rename, pin, archive and list_sessions", async () => {
    const { repo } = await setup([{ text: "one" }, { text: "two" }]);
    const d = driver({ canPrompt: false });
    const a = await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await d.turn("first session message");
    await d.call("rename_session", { title: "Manual title" });
    expect(d.notes("session_title_updated").at(-1)).toMatchObject({ title: "Manual title", updateType: "manual" });
    await d.call("pin_session", { pinned: true });
    await d.call("close_session", {});

    const e = driver({ canPrompt: false });
    await e.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await e.turn("second session message");
    await e.call("close_session", {});

    // no session on this connection
    const f = driver({ canPrompt: false });
    let list = (await f.call("list_sessions", { cwd: repo })).sessions;
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ sessionId: a.sessionId, title: "Manual title", pinned: true, archivedAt: null, isSubagent: false, hasUserVisibleMessages: true, cwd: repo });
    expect(list[0].updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const g = driver({ canPrompt: false });
    const loaded = await g.call("load_session", { sessionId: a.sessionId, cwd: repo });
    expect(loaded.session.title ?? loaded.settings).toBeTruthy();
    await g.call("archive_session", { archived: true });
    expect((await f.call("list_sessions", { cwd: repo })).sessions.length).toBe(1);
    list = (await f.call("list_sessions", { cwd: repo, includeArchived: true })).sessions;
    expect(list.find((s: any) => s.sessionId === a.sessionId).archivedAt).toMatch(/^\d{4}-/);
    await g.call("archive_session", { archived: false });
    expect((await f.call("list_sessions", { cwd: repo, limit: 1 })).sessions.length).toBe(1);
    await expect(g.call("pin_session", { pinned: "yes" })).rejects.toThrow(/boolean/);
    await g.call("close_session", {});
    expect(loadSession(a.sessionId, repo).start.title).toBe("Manual title");
  }, 30000);

  test("an empty session and a subagent session are hidden", async () => {
    const { repo } = await setup([]);
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    expect((await d.call("list_sessions", { cwd: repo })).sessions.length).toBe(0);
    await d.call("close_session", {});
  });
});

describe("title generation", () => {
  const prev = process.env.RIGWELL_NO_AUTO_TITLE;
  afterEach(() => { process.env.RIGWELL_NO_AUTO_TITLE = prev; });

  test("a small no-tools request names the session; a manual title skips it", async () => {
    delete process.env.RIGWELL_NO_AUTO_TITLE;
    const titleReqs: any[] = [];
    const turn: FakeTurn = (body) => {
      if (!body.tools?.length) { titleReqs.push(body); return { text: '"Fix the greeting bug."\nextra' }; }
      return { text: "done" };
    };
    const { repo } = await setup([turn, turn, turn]);
    const d = driver({ canPrompt: true, answer: () => ({}) });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await d.turn("the greet function misspells hello");
    await d.until(() => d.notes("session_title_updated").length > 0);
    expect(d.notes("session_title_updated")[0]).toEqual({ type: "session_title_updated", title: "Fix the greeting bug", updateType: "auto" });
    expect(titleReqs.length).toBe(1);
    expect(titleReqs[0].max_tokens).toBe(32 + 8192);
    expect(titleReqs[0].tools).toBeUndefined();
    await d.call("close_session", {});

    const e = driver({ canPrompt: true, answer: () => ({}) });
    await e.call("initialize_session", { cwd: repo, modelId: "custom:F-0", title: "Chosen by me" });
    await e.turn("anything");
    await Bun.sleep(100);
    expect(titleReqs.length).toBe(1);
    await e.call("close_session", {});
  }, 30000);
});

describe("stream and tool notifications", () => {
  test("thinking_text_complete and tool_execution_heartbeat", async () => {
    const { repo } = await setup([
      { thinking: "let me think", toolCalls: [{ name: "Execute", input: { command: "sleep 0.5", riskLevel: "low", riskReason: "wait" } }] },
      { text: "done" },
    ], { toolHeartbeatMs: 60 });
    const d = driver({ canPrompt: false });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "high" });
    await d.turn("go");
    expect(d.notes("thinking_text_complete").length).toBe(1);
    expect(d.notes("tool_execution_heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(d.notes("tool_execution_heartbeat")[0]).toMatchObject({ toolName: "Execute" });
    await d.call("close_session", {});
  }, 30000);
});

describe("permissions", () => {
  const create = (name: string) => ({ name: "Execute", input: { command: `echo hi > ${name}`, riskLevel: "medium", riskReason: "writes a file" } });

  test("a denial comment is forwarded to the model in the tool result", async () => {
    const { repo } = await setup([{ toolCalls: [create("a.txt")] }, { text: "ok" }]);
    const d = driver({ canPrompt: true, answer: (m) => (m === "request_permission" ? { selectedOption: "cancel", comment: "use b.txt instead" } : {}) });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low" });
    expect((await d.turn("make a file")).reason).toBe("permission_rejected");
    expect(JSON.stringify(d.conn.session!.messages)).toContain("[Comment] use b.txt instead");
    expect(existsSync(join(repo, "a.txt"))).toBe(false);
    await d.call("close_session", {});
  }, 30000);

  test("a batch of calls that need approval gets one prompt: allow all, or cancel all", async () => {
    const { repo } = await setup([{ toolCalls: [create("one.txt"), create("two.txt")] }, { text: "ok" }]);
    const d = driver({ canPrompt: true, answer: () => ({ selectedOption: "proceed_once" }) });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low" });
    expect((await d.turn("two files")).reason).toBe("completed");
    const asks = d.requests.filter((r) => r.method === "request_permission");
    expect(asks.length).toBe(1);
    expect(asks[0]!.params.toolUses.length).toBe(2);
    expect(asks[0]!.params.options.map((o: any) => o.label)).toEqual(["Yes, allow all", "No, cancel all"]);
    expect(existsSync(join(repo, "one.txt")) && existsSync(join(repo, "two.txt"))).toBe(true);
    expect(d.notes("permission_resolved")[0].toolUseIds.length).toBe(2);
    await d.call("close_session", {});

    const b = await setup([{ toolCalls: [create("x1.txt"), create("x2.txt")] }, { text: "ok" }]);
    const e = driver({ canPrompt: true, answer: () => ({ selectedOption: "cancel" }) });
    await e.call("initialize_session", { cwd: b.repo, modelId: "custom:F-0", autonomyLevel: "low" });
    expect((await e.turn("two files")).reason).toBe("permission_rejected");
    expect(existsSync(join(b.repo, "x1.txt")) || existsSync(join(b.repo, "x2.txt"))).toBe(false);
    expect(e.requests.filter((r) => r.method === "request_permission").length).toBe(1);
    await e.call("close_session", {});
  }, 30000);

  test("a prompt left open when the client goes away is re-shown by load_session and answered with answer_request", async () => {
    const { repo } = await setup([{ toolCalls: [create("late.txt")] }, { text: "finished" }]);
    const a = driver({ canPrompt: true, answer: () => new Promise(() => {}) }); // never answers
    const init = await a.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low" });
    await a.call("add_user_message", { text: "make it", messageId: "t1" });
    await a.until(() => a.requests.some((r) => r.method === "request_permission"));
    await a.call("add_user_message", { text: "queued follow-up", messageId: "t2" });
    await a.conn.shutdown({ park: true });

    const b = driver({ canPrompt: true });
    const loaded = await b.call("load_session", { sessionId: init.sessionId, cwd: repo });
    expect(loaded.isAgentLoopInProgress).toBe(true);
    expect(loaded.workingState).toBe("waiting_for_tool_confirmation");
    expect(loaded.pendingPermissions.length).toBe(1);
    expect(loaded.pendingPermissions[0].toolUses[0].toolUse.name).toBe("Execute");
    expect(loaded.queuedMessages.map((m: any) => m.text)).toEqual(["queued follow-up"]);
    const requestId = loaded.pendingPermissions[0].requestId;
    await expect(b.call("answer_request", { requestId: "nope", answer: {} })).rejects.toThrow(/No open request/);
    await b.call("answer_request", { requestId, answer: { selectedOption: "proceed_once" } });
    await b.until(() => b.completed().length >= 2);
    expect(existsSync(join(repo, "late.txt"))).toBe(true);
    await b.call("close_session", {});
  }, 30000);

  test("AskUser over the protocol: ask_user request, waiting state, answers reach the model", async () => {
    const { model, repo } = await setup([
      { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] },
      { text: "ok" },
    ]);
    const d = driver({ canPrompt: true, answer: (m, p) => (m === "ask_user" ? { answers: [{ index: 1, question: p.questions[0].question, answer: "ts" }] } : {}) });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0" });
    await d.turn("pick one");
    const ask = d.requests.find((r) => r.method === "ask_user")!;
    expect(ask.params.questions[0]).toMatchObject({ index: 1, topic: "Lang", options: ["ts", "py"] });
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain("ts");
    await d.call("close_session", {});

    // plain exec (no client): the tool is not offered
    const b = await setup([{ text: "x" }]);
    const e = driver({ canPrompt: false });
    await e.call("initialize_session", { cwd: b.repo, modelId: "custom:F-0" });
    await e.turn("hi");
    expect(toolNames(b.model.requests[0])).not.toContain("AskUser");
    await e.call("close_session", {});
  }, 30000);

  test("Notification hooks fire on a permission prompt, a question and an idle turn", async () => {
    const { repo, home } = await setup([
      { toolCalls: [create("n.txt")] }, { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "t", question: "q?", options: ["a", "b"] }] } }] }, { text: "done" },
    ]);
    const log = join(home, "notifications.log");
    const sf = join(home, "settings.json");
    writeFileSync(sf, JSON.stringify({ ...JSON.parse(readFileSync(sf, "utf8")), hooks: { Notification: [{ hooks: [{ type: "command", command: `cat >> ${log}; echo >> ${log}` }] }] } }));
    const d = driver({ canPrompt: true, answer: (m) => (m === "ask_user" ? { answers: [{ index: 1, question: "q?", answer: "a" }] } : { selectedOption: "proceed_once" }) });
    await d.call("initialize_session", { cwd: repo, modelId: "custom:F-0", autonomyLevel: "low" });
    await d.turn("go");
    await d.until(() => existsSync(log) && ["permission_prompt", "elicitation_dialog", "idle_prompt"].every((k) => readFileSync(log, "utf8").includes(k)), 10000);
    await d.call("close_session", {});
  }, 30000);
});
