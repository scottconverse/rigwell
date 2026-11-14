import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, type watch } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { setup, until } from "./helpers.ts";
import { makeGitRepo, tmp } from "../worktree/util.ts";
import type { FakeTurnSpec } from "../fakes/types.ts";
import { canonicalPath } from "../../src/worktree/git.ts";
import { WorkstreamListeners } from "../../src/workstreams/listeners.ts";

const question: FakeTurnSpec = { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Hold", question: "Continue?", options: ["yes", "no"] }] } }] };
const answer = { answers: [{ index: 1, question: "Continue?", answer: "yes" }] };

test("rearmed file listeners reconcile a creation omitted by an armed native watcher", async () => {
  const f = await setup(); let closed = 0;
  const silentWatch = (() => Object.assign(new EventEmitter(), { unref() {}, close() { closed++; } })) as unknown as typeof watch;
  const before = new WorkstreamListeners({ watch: silentWatch, fire() {} });
  const after = new WorkstreamListeners({ watch: silentWatch, fire() {} });
  try {
    const result = before.create(f.store, "lead", { on: "file_changed", filter: { glob: "*.txt" } });
    before.close(); after.rearm(f.store);
    const path = f.store.path("shared/reconciled.txt"); writeFileSync(path, "Written immediately after rearm");
    const waited = await after.wait(f.store, "lead", { listenerIds: [result.listenerId], timeoutMs: 3000 });
    expect(waited.events).toMatchObject([{ on: "file_changed", trigger: { path: canonicalPath(path), change: "rename" } }]);
    expect(f.store.listeners()).toHaveLength(0); expect(closed).toBe(2);
  } finally { before.close(); after.close(); await f.close(); }
});

test("recurring file reconciliation detects edits and deletion without native callbacks", async () => {
  const f = await setup();
  const silentWatch = (() => Object.assign(new EventEmitter(), { unref() {}, close() {} })) as unknown as typeof watch;
  const listeners = new WorkstreamListeners({ watch: silentWatch, fire() {} });
  try {
    const path = f.store.path("shared/existing.txt"); writeFileSync(path, "Before");
    const result = listeners.create(f.store, "lead", { on: "file_changed", once: false, filter: { glob: "*.txt" } });
    writeFileSync(f.store.path("shared/ignore.md"), "Not a match"); writeFileSync(path, "Changed contents");
    expect((await listeners.wait(f.store, "lead", { listenerIds: [result.listenerId], timeoutMs: 3000 })).events).toMatchObject([{ trigger: { path: canonicalPath(path), change: "change" } }]);
    rmSync(path);
    expect((await listeners.wait(f.store, "lead", { listenerIds: [result.listenerId], timeoutMs: 3000 })).events).toMatchObject([{ trigger: { path: canonicalPath(path), change: "rename" } }]);
    expect(f.store.events().filter((e) => e.type === "listener_fired")).toHaveLength(2);
    listeners.archive(f.store); expect(f.store.listeners()).toHaveLength(0);
  } finally { listeners.close(); await f.close(); }
});
const busy = (body: any): FakeTurnSpec => JSON.stringify(body.messages.at(-1)).includes("BUSY") ? question : { text: "Finished" };

test("filtered idle/completion listeners and all_idle wait for both real members", async () => {
  const f = await setup(busy);
  try {
    await f.member.call("add_user_message", { text: "BUSY" });
    const second = await f.service.spawn(f.lead.connection.session!, { name: "Second", role: "task", prompt: "BUSY", worktree: false });
    await until(() => f.prompts.length === 2);
    const idle = f.service.listeners.create(f.store, "lead", { on: "agent_idle", filter: { name: "fIrSt" }, note: "First is ready" });
    const complete = f.service.listeners.create(f.store, "lead", { on: "agent_turn_completed", filter: { agentId: f.first.agentId } });
    const all = f.service.listeners.create(f.store, "lead", { on: "all_idle" });
    f.prompts.find((p) => p.params.agentId === f.first.agentId)!.answer(answer);
    await f.member.connection.session!.idle();
    const firstEvents = await f.service.listeners.wait(f.store, "lead", { listenerIds: [idle.listenerId, complete.listenerId], timeoutMs: 0 });
    expect(firstEvents.events.map((e) => e.on).sort()).toEqual(["agent_idle", "agent_turn_completed"]);
    expect(firstEvents.events.every((e) => (e.trigger as any).agentId === f.first.agentId)).toBe(true);
    expect(f.store.events().some((e) => e.type === "listener_fired" && e.listenerId === all.listenerId)).toBe(false);
    const waiting = f.service.listeners.wait(f.store, "lead", { listenerIds: [all.listenerId], timeoutMs: 3000 });
    f.prompts.find((p) => p.params.agentId === second.agentId)!.answer(answer);
    expect((await waiting).events).toMatchObject([{ on: "all_idle" }]);
    await f.lead.connection.session!.idle();
    expect(f.store.listeners()).toHaveLength(0);
    expect(f.lead.connection.session!.uiMessages().some((m) => JSON.stringify(m.content).includes("First is ready"))).toBe(true);
    expect(f.notifications.some((n) => n.type === "workstream_listener_fired")).toBe(true);
  } finally { await f.close(); }
});

test("waiting-input and failure listeners retain the actual member outcome", async () => {
  const f = await setup((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("FAIL_AFTER_QUESTION")) return question;
    if (last.includes("tool_result")) return { status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "fixture failure" } } };
    return { text: "Finished" };
  });
  try {
    const input = f.service.listeners.create(f.store, "lead", { on: "agent_waiting_input", filter: { agentId: f.first.agentId } });
    const failure = f.service.listeners.create(f.store, "lead", { on: "agent_failed", filter: { name: "First" } });
    await f.member.call("add_user_message", { text: "FAIL_AFTER_QUESTION" });
    await until(() => f.prompts.length === 1);
    expect((await f.service.listeners.wait(f.store, "lead", { listenerIds: [input.listenerId], timeoutMs: 0 })).events).toMatchObject([{ on: "agent_waiting_input" }]);
    f.prompts[0]!.answer(answer);
    await f.member.connection.session!.idle();
    expect((await f.service.listeners.wait(f.store, "lead", { listenerIds: [failure.listenerId], timeoutMs: 0 })).events).toMatchObject([{ on: "agent_failed" }]);
    expect(f.store.agent(f.first.agentId)!.status).toBe("failed");
  } finally { await f.close(); }
});

test("members create only their own incoming-message listeners; lead message filters apply", async () => {
  const f = await setup((body) => {
    if (JSON.stringify(body.messages.at(-1)).includes("CREATE_OWN_LISTENER")) return { toolCalls: [{ name: "CreateListener", input: { on: "message", note: "member inbox" } }] };
    return { text: "Finished" };
  });
  try {
    await f.member.call("add_user_message", { text: "CREATE_OWN_LISTENER" });
    await f.member.connection.session!.idle();
    const own = f.store.listeners()[0]!;
    expect(own).toMatchObject({ owner: f.first.agentId, on: "message", filter: { to: f.first.agentId } });
    expect(() => f.service.listeners.create(f.store, f.first.agentId, { on: "timer", filter: { afterMs: 5 } })).toThrow("only for messages");
    expect(() => f.service.listeners.create(f.store, f.first.agentId, { on: "message", filter: { to: "lead" } })).toThrow("only for messages");
    const lead = f.service.listeners.create(f.store, "lead", { on: "message", filter: { name: "First" } });
    f.service.send(f.lead.connection.session!.id, { to: "First", message: "member data" });
    expect(f.store.events().some((e) => e.type === "listener_fired" && e.listenerId === own.id)).toBe(true);
    expect(f.store.events().some((e) => e.type === "listener_fired" && e.listenerId === lead.listenerId)).toBe(false);
    f.service.send(f.first.sessionId, { to: "lead", message: "lead data" });
    expect((await f.service.listeners.wait(f.store, "lead", { listenerIds: [lead.listenerId], timeoutMs: 0 })).events).toMatchObject([{ on: "message", trigger: { from: f.first.agentId, to: "lead" } }]);
    expect(() => f.service.listeners.wait(f.store, "lead", { listenerIds: [own.id], timeoutMs: 0 })).toThrow("another participant");
  } finally { await f.close(); }
});

test("file listeners watch matching shared files and refuse globs outside allowed roots", async () => {
  const f = await setup();
  try {
    expect(() => f.service.listeners.create(f.store, "lead", { on: "file_changed", filter: { glob: "../outside/*" } })).toThrow("escape");
    expect(() => f.service.listeners.create(f.store, "lead", { on: "file_changed", filter: { glob: join(tmp("ws-outside"), "*.txt") } })).toThrow("must stay under");
    const file = f.service.listeners.create(f.store, "lead", { on: "file_changed", filter: { glob: "shared/**/*.txt" } });
    const waiting = f.service.listeners.wait(f.store, "lead", { listenerIds: [file.listenerId], timeoutMs: 3000 });
    mkdirSync(f.store.path("shared/sub"));
    writeFileSync(f.store.path("shared/ignore.md"), "unmatched");
    const path = f.store.path("shared/sub/notes.txt"); writeFileSync(path, "handoff");
    expect((await waiting).events).toMatchObject([{ on: "file_changed", trigger: { path: canonicalPath(path) } }]);
    expect(f.store.listeners()).toHaveLength(0);
  } finally { await f.close(); }
});

test("file listener scopes an existing member's separate worktree", async () => {
  const f = await setup();
  try {
    const agent = await f.service.spawn(f.lead.connection.session!, { name: "Isolated", role: "task", prompt: "INITIAL", cwd: makeGitRepo() });
    await f.service.members.get(agent.agentId)!.connection.session!.idle();
    const file = f.service.listeners.create(f.store, "lead", { on: "file_changed", filter: { agentId: agent.agentId, glob: "*.txt" } });
    const waiting = f.service.listeners.wait(f.store, "lead", { listenerIds: [file.listenerId], timeoutMs: 3000 });
    const path = join(agent.worktreePath!, "member-notes.txt"); writeFileSync(path, "member handoff");
    expect((await waiting).events).toMatchObject([{ on: "file_changed", trigger: { path: canonicalPath(path) } }]);
  } finally { await f.close(); }
});

test("timers default to one shot; recurring events, timeout, abort and shutdown remain bounded", async () => {
  const f = await setup();
  try {
    const timer = f.service.listeners.create(f.store, "lead", { on: "timer", filter: { afterMs: 10 } });
    expect((await f.service.listeners.wait(f.store, "lead", { listenerIds: [timer.listenerId], timeoutMs: 3000 })).events).toMatchObject([{ on: "timer" }]);
    expect(f.store.listeners()).toHaveLength(0);
    expect(await f.service.listeners.wait(f.store, "lead", { listenerIds: [timer.listenerId], timeoutMs: 1 })).toEqual({ events: [], timedOut: true });
    const recurring = f.service.listeners.create(f.store, "lead", { on: "timer", once: false, filter: { afterMs: 15 } });
    const one = await f.service.listeners.wait(f.store, "lead", { listenerIds: [recurring.listenerId], timeoutMs: 3000 });
    const two = await f.service.listeners.wait(f.store, "lead", { listenerIds: [recurring.listenerId], timeoutMs: 3000 });
    expect(one.events[0]!.id).not.toBe(two.events[0]!.id);
    expect(f.store.listeners()).toHaveLength(1);
    const controller = new AbortController();
    const aborted = f.service.listeners.wait(f.store, "lead", { listenerIds: [timer.listenerId] }, controller.signal);
    controller.abort(); expect(await aborted).toEqual({ events: [], cancelled: true });
    const closed = f.service.listeners.wait(f.store, "lead", { listenerIds: [timer.listenerId] });
    expect(() => f.service.listeners.create(f.store, "lead", { on: "timer", once: false, filter: { afterMs: 0 } })).toThrow("positive");
    f.service.listeners.close(); expect(await closed).toEqual({ events: [], cancelled: true });
    const count = f.store.events().filter((e) => e.type === "listener_fired").length;
    await Bun.sleep(25);
    expect(f.store.events().filter((e) => e.type === "listener_fired")).toHaveLength(count);
  } finally { await f.close(); }
});

test("real lead tools create a timer and WaitForEvents returns its fired event without polling", async () => {
  const f = await setup((body) => {
    if (!JSON.stringify(body.messages).includes("LISTEN_AND_WAIT")) return { text: "Finished" };
    const calls = body.messages.flatMap((m: any) => m.content?.filter((c: any) => c.type === "tool_use") ?? []);
    if (!calls.some((c: any) => c.name === "CreateListener")) return { toolCalls: [{ name: "CreateListener", input: { on: "timer", filter: { afterMs: 60 }, note: "Fixture timer" } }] };
    if (!calls.some((c: any) => c.name === "WaitForEvents")) return { toolCalls: [{ name: "WaitForEvents", input: { timeoutMs: 3000 } }] };
    return { text: "Event received" };
  });
  try {
    await f.lead.call("add_user_message", { text: "LISTEN_AND_WAIT" });
    await f.lead.connection.session!.idle();
    expect(f.store.events().filter((e) => e.type === "listener_wait_read")).toHaveLength(1);
    const transcript = JSON.stringify(f.lead.connection.session!.uiMessages());
    expect(transcript).toContain("WaitForEvents"); expect(transcript).toContain("listener_fired");
    expect(transcript).toContain("Fixture timer"); expect(transcript).toContain("Event received");
  } finally { await f.close(); }
});
