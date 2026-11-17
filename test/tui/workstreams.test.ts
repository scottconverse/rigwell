import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildView } from "../../src/tui/views.ts";
import { runTui } from "../../src/tui/app.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { driver, ev, key, note, type } from "./helpers.ts";
import { startTestDaemon } from "../desktop/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { listWorkstreamStores } from "../../src/workstreams/store.ts";
import { tmp } from "../worktree/util.ts";
import { until } from "../workstreams/helpers.ts";

test("Workstreams has its own picker, opens a live detail and leaves Missions separate", async () => {
  expect(key(type(driver(), "/workstreams"), "enter").effects).toEqual([{ type: "view", name: "workstreams", args: "" }]);
  expect(key(type(driver(), "/missions"), "enter").effects).toEqual([{ type: "list_missions" }]);
  const picked = key(ev(driver(), { type: "workstreams", rows: [{ id: "ws", title: "Build", state: "active", agentCount: 2 }] }), "enter");
  expect(picked.effects).toEqual([{ type: "view", name: "workstreams", args: "ws" }]);
  const view = ev(driver(), { type: "overlay", title: "Workstream: Build", lines: [], workstreamId: "ws" });
  expect(note(view, { type: "workstream_message", workstreamId: "ws" }).effects).toEqual([{ type: "view", name: "workstreams", args: "ws", refresh: true }]);
  expect(key(type(driver(), '/ws send "Builder one" hello'), "enter").effects).toEqual([{ type: "view", name: "workstreams", args: 'send "Builder one" hello' }]);
});

test("TUI proposal edit sends only the edited plan and lead completion retains member prompts", () => {
  let d = ev(driver(), { type: "request", id: "proposal", method: "request_permission", params: { toolUses: [{ confirmationType: "propose_workstream", details: { title: "Build", goal: "Ship", plan: "Original", budget: { maxTokens: 500 } } }], options: [{ label: "Edit", value: "proceed_edit" }, { label: "Reject", value: "cancel" }] } });
  expect(d.s.panels[0].body.join("\n")).toContain("500");
  expect(key(d, "enter").effects.filter((e) => e.type === "editor")).toEqual([{ type: "editor", text: "Original", target: "spec" }]);
  d = ev(d, { type: "spec_edited", text: "Edited plan" });
  expect(d.s.panels[0].body.join("\n")).toContain("500");
  expect(key(d, "enter").effects).toEqual([{ type: "answer", requestId: "proposal", method: "request_permission", result: { selectedOption: "proceed_edit", editedSpecContent: "Edited plan" } }]);
  const member = ev(driver(), { type: "request", id: "question", method: "ask_user", params: { workstreamId: "ws", agentId: "a", workstreamTitle: "Build", agentName: "Builder", questions: [{ index: 0, question: "Continue?", options: ["yes"] }] } });
  const finished = note(member, { type: "agent_turn_completed", reason: "completed" });
  expect(finished.s.panels).toHaveLength(1); expect(finished.effects.some((e) => e.type === "answer")).toBe(false);
  expect(finished.s.panels[0].title).toContain("Build / Builder");
});

test("workstream view sends as the user, resolves names for interruption and reports daemon-only availability", async () => {
  const calls: any[] = [];
  const c = { state: driver({ workstreamId: "ws" }).s, connection: "test", request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "list_workstreams") return { workstreams: [{ id: "ws" }] };
    if (method === "get_workstream") return { workstream: { id: "ws", title: "Build", state: "active", goal: "Ship" }, roster: [{ agentId: "a", name: "Builder one", role: "Code", status: "idle", tokens: 20, costUsd: 0, costKnown: false }], messages: [{ from: "user", to: "a", priority: "next", text: "hello" }] };
    return {};
  } };
  expect((await buildView("workstreams", 'send "Builder one" hello there', c)).lines.join("\n")).toContain("cost unpriced");
  expect(calls).toContainEqual({ method: "workstream_send", params: { id: "ws", to: "Builder one", message: "hello there", priority: "next" } });
  await buildView("workstreams", 'interrupt "Builder one"', c);
  expect(calls).toContainEqual({ method: "workstream_interrupt", params: { id: "ws", agentId: "a" } });
  expect((await buildView("workstreams", "", { ...c, request: async () => { throw new Error("Method not found"); } })).lines.join("\n")).toContain("rigwell --daemon");
});

test("headless TUI drives proposal approval, member prompts, roster, messages and interruption through the real daemon", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 40 }, () => (body: any) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("START WORKSTREAM")) return { toolCalls: [{ name: "ProposeWorkstream", input: { title: "Terminal team", goal: "Ship", plan: "Coordinate" } }] };
    if (last.includes('\\"accepted\\":true')) return { toolCalls: [{ name: "SpawnAgent", input: { name: "Builder", role: "Code", prompt: "BUSY", worktree: false } }] };
    if (last.includes("BUSY")) return { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Choice", question: "Member continue?", options: ["yes", "no"] }] } }] };
    return { text: "Turn finished" };
  }));
  const { d, home } = await startTestDaemon(fake.url);
  const settings = join(home, "settings.json"); writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), awaitingInputSound: "off", completionSound: "off" }));
  const stdin = new PassThrough(), stdout = new PassThrough(); let output = "";
  Object.assign(stdin, { isTTY: true, setRawMode() {} }); Object.assign(stdout, { isTTY: true, columns: 120, rows: 60 });
  stdout.on("data", (chunk) => { output += chunk; });
  const done = runTui({ cwd: tmp("ws-tui"), makeTransport: () => SocketTransport.connect(d.socketPath), sessionParams: { modelId: "custom:Fake-Anthropic-0", autonomyLevel: "low" }, stdin: stdin as any, stdout: stdout as any, connection: "daemon test" });
  try {
    await until(() => output.includes("Rigwell")); stdin.write("START WORKSTREAM\r");
    await until(() => output.includes("Workstream for approval")); stdin.write("1");
    await until(() => listWorkstreamStores().length === 1 && d.workstreams.members.size === 1);
    const store = listWorkstreamStores()[0]!, row = store.roster()[0]!, member = d.workstreams.members.get(row.agentId)!;
    await until(() => member.connection.session?.pendingPrompts().length === 1 && output.includes("Turn finished") && output.includes("Terminal team / Builder"));
    expect(output).toContain("Terminal team / Builder"); expect(member.connection.session!.pendingPrompts()).toHaveLength(1);
    stdin.write("1"); await member.connection.session!.idle();
    output = ""; stdin.write("/workstreams\r"); await until(() => output.includes("Terminal team")); stdin.write("1");
    await until(() => output.includes("Workstream: Terminal team") && output.includes("Builder [idle]"));
    stdin.write("\x1b"); output = ""; stdin.write("/ws send Builder HELLO TUI\r");
    await until(() => store.messages().some((m) => m.text === "HELLO TUI")); await member.connection.session!.idle();
    expect(store.messages().at(-1)!.from).toBe("user");
    await until(() => output.includes("Workstream: Terminal team")); stdin.write("\x1b"); stdin.write("/ws interrupt Builder\r");
    await until(() => store.agent(row.agentId)!.status === "interrupted");
    expect(store.events().some((e) => e.type === "agent_interrupted")).toBe(true);
    d.workstreams.send(store.read().leadSessionId, { to: row.agentId, message: "BUSY" });
    await until(() => member.connection.session!.pendingPrompts().length === 1);
    stdin.end(); expect(await done).toBe(0);
    expect(member.connection.session!.pendingPrompts()).toHaveLength(1);
  } finally { stdin.end(); await done; await d.workstreams.stop(); d.stop(); fake.stop(); }
}, 15_000);
