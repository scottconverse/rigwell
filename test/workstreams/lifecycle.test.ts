import { expect, test } from "bun:test";
import { appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, until } from "./helpers.ts";
import { makeGitRepo, tmp } from "../worktree/util.ts";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import type { FakeTurnSpec } from "../fakes/types.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { managerFor } from "../../src/worktree/connect.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { makeHome } from "../e2e/helpers.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { MemberSession } from "../../src/workstreams/member.ts";

const question: FakeTurnSpec = { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Hold", question: "Continue?", options: ["yes", "no"] }] } }] };
const busy = (body: any): FakeTurnSpec => JSON.stringify(body.messages.at(-1)).includes("BUSY") ? question : { text: "Finished", usage: { input: 10, output: 5, cacheRead: 2, cacheCreation: 3 } };

test("member controls interrupt a turn, rename its transcript and archive without losing history", async () => {
  const f = await setup(busy);
  try {
    await f.member.call("add_user_message", { text: "BUSY" }); await until(() => f.prompts.length > 0);
    expect(f.service.interrupt(f.lead.connection.session!.id, { agentId: f.first.agentId, reason: "Task changed" })).toEqual({ status: "interrupted" });
    await f.member.connection.session!.idle();
    expect(f.store.agent(f.first.agentId)!.status).toBe("interrupted");
    await f.service.rename(f.lead.connection.session!.id, { agentId: f.first.agentId, name: "Updated" });
    expect(f.store.agent(f.first.agentId)!.name).toBe("Updated");
    const listed = await f.lead.call("list_sessions");
    expect(listed.sessions.find((s: any) => s.sessionId === f.first.sessionId).title).toBe("Updated");
    expect(await f.service.archive(f.lead.connection.session!.id, { agentId: f.first.agentId })).toEqual({ archived: true, worktreeKept: false });
    expect(f.service.members.has(f.first.agentId)).toBe(false);
    expect(f.store.agent(f.first.agentId)!.status).toBe("archived");
    expect((await f.lead.call("list_sessions", { includeArchived: true })).sessions.find((s: any) => s.sessionId === f.first.sessionId).archivedAt).toBeTruthy();
    expect(f.store.events().map((e) => e.type)).toContain("agent_interrupted");
  } finally { await f.close(); }
});

test("archive cleanup removes a safe worktree and retains dirty work", async () => {
  const f = await setup();
  try {
    const repo = makeGitRepo();
    const clean = await f.service.spawn(f.lead.connection.session!, { name: "Clean", role: "task", prompt: "INITIAL", cwd: repo });
    await f.service.members.get(clean.agentId)!.connection.session!.idle();
    expect(await f.service.archive(f.lead.connection.session!.id, { agentId: clean.agentId, cleanupWorktree: true })).toEqual({ archived: true, worktreeKept: false });
    expect(existsSync(clean.worktreePath!)).toBe(false);
    const dirty = await f.service.spawn(f.lead.connection.session!, { name: "Dirty", role: "task", prompt: "INITIAL", cwd: repo });
    await f.service.members.get(dirty.agentId)!.connection.session!.idle();
    writeFileSync(join(dirty.worktreePath!, "uncommitted.txt"), "Keep this");
    expect(await f.service.archive(f.lead.connection.session!.id, { agentId: dirty.agentId, cleanupWorktree: true })).toEqual({ archived: true, worktreeKept: true });
    expect(readFileSync(join(dirty.worktreePath!, "uncommitted.txt"), "utf8")).toBe("Keep this");
    expect(await managerFor(loadSettings({ cwd: repo }).settings).get(dirty.worktreePath!)).toBeTruthy();
  } finally { await f.close(); }
}, 15_000);

test("concurrency cap queues both extra spawns and later messages behind a member awaiting input", async () => {
  const f = await setup(busy);
  try {
    f.store.update({ settings: { ...f.store.read().settings, maxConcurrentAgents: 1 } });
    const second = await f.service.spawn(f.lead.connection.session!, { name: "Second", role: "task", prompt: "BUSY", worktree: false });
    await until(() => f.prompts.length > 0);
    const third = await f.service.spawn(f.lead.connection.session!, { name: "Third", role: "task", prompt: "THIRD", worktree: false });
    f.service.send(f.lead.connection.session!.id, { to: "First", message: "QUEUED MESSAGE" });
    await until(() => f.store.agent(f.first.agentId)!.status === "starting");
    expect(f.store.agent(third.agentId)!.status).toBe("starting");
    expect(JSON.stringify(f.fake.requests)).not.toContain("THIRD");
    expect(JSON.stringify(f.fake.requests)).not.toContain("QUEUED MESSAGE");
    f.service.interrupt(f.lead.connection.session!.id, { agentId: second.agentId });
    await until(() => f.store.agent(third.agentId)!.status === "idle" && f.store.agent(f.first.agentId)!.status === "idle");
    expect(JSON.stringify(f.fake.requests)).toContain("THIRD"); expect(JSON.stringify(f.fake.requests)).toContain("QUEUED MESSAGE");
  } finally { await f.close(); }
});

test("pause holds messages and fired listener wakes until user resume", async () => {
  const f = await setup(busy);
  try {
    await f.member.call("add_user_message", { text: "BUSY" }); await until(() => f.prompts.length > 0);
    f.service.pause(f.store.id);
    await f.member.connection.session!.idle();
    const message = f.service.send(f.lead.connection.session!.id, { to: "First", message: "HELD" });
    expect(message.delivered).toBe(false);
    f.service.listeners.create(f.store, f.first.agentId, { on: "message" });
    f.service.send(f.lead.connection.session!.id, { to: "First", message: "WAKE HELD" });
    expect(f.store.events().some((e) => e.type === "listener_fired")).toBe(true);
    expect(f.store.events().some((e) => e.type === "listener_wake_delivered")).toBe(false);
    expect(JSON.stringify(f.fake.requests)).not.toContain("HELD");
    await f.service.resume(f.store.id);
    await f.member.connection.session!.idle();
    expect(JSON.stringify(f.fake.requests)).toContain("HELD");
    expect(f.store.messages().every((m) => m.deliveredAt && m.readAt)).toBe(true);
    expect(f.store.events().some((e) => e.type === "listener_wake_delivered")).toBe(true);
  } finally { await f.close(); }
});

test("token budget accounts for cached tokens, pauses and requires a changed budget to resume", async () => {
  const f = await setup(busy);
  try {
    const before = f.store.agent(f.first.agentId)!.tokens;
    f.store.update({ budget: { maxTokens: before + 20 } });
    await f.member.call("add_user_message", { text: "USE BUDGET" }); await f.member.connection.session!.idle();
    expect(f.store.agent(f.first.agentId)!.tokens).toBe(before + 20);
    expect(f.store.read().state).toBe("paused");
    expect(f.store.agent(f.first.agentId)!.status).toBe("interrupted");
    expect(f.notifications.some((n) => n.type === "workstream_budget_reached")).toBe(true);
    const error = await f.service.resume(f.store.id).then(() => null, (e) => e);
    expect(error.message).toContain("budget is still reached");
    const sent = f.service.send(f.lead.connection.session!.id, { to: "First", message: "RESUMED" }); expect(sent.delivered).toBe(false);
    await f.service.resume(f.store.id, { budget: { maxTokens: before + 100 } }); await f.member.connection.session!.idle();
    expect(f.store.read().state).toBe("active"); expect(f.store.messages().find((m) => m.id === sent.messageId)?.deliveredAt).toBeTruthy();
  } finally { await f.close(); }
});

test("hard daemon-owner restart retains session identity, interrupted status, queued messages and rearmed listeners", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 40 }, () => busy));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const cwd = tmp("ws-crash"), file = join(cwd, "ready.json");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/crash-member.ts")], { env: { ...process.env, FIXTURE_CWD: cwd, FIXTURE_READY: file }, stdout: "pipe", stderr: "pipe" });
  let recovered: ReturnType<typeof createWorkstreamService> | undefined;
  try {
    await until(() => existsSync(file));
    const { workstreamId, agent, queued } = JSON.parse(readFileSync(file, "utf8"));
    child.kill(9); await child.exited;
    const store = new WorkstreamStore(workstreamId);
    expect(store.agent(agent.agentId)!.status).toBe("waiting_input");
    recovered = createWorkstreamService(); await recovered.ready;
    expect(store.agent(agent.agentId)!.status).toBe("interrupted"); expect(store.read().state).toBe("paused");
    const session = recovered.members.get(agent.agentId)!.connection.session!;
    expect(session.id).toBe(agent.sessionId); expect(session.pendingPrompts()).toHaveLength(0);
    expect(store.messages().find((m) => m.id === queued.messageId)?.deliveredAt).toBeUndefined();
    writeFileSync(store.path("shared/restarted.txt"), "Watch after restart");
    await until(() => store.events().some((e) => e.type === "listener_fired" && e.on === "file_changed"));
    await recovered.resume(store.id); await session.idle();
    expect(session.uiMessages().filter((m) => m.id === queued.messageId)).toHaveLength(1);
    expect(store.messages().find((m) => m.id === queued.messageId)?.readAt).toBeTruthy();
    expect(store.events().some((e) => e.type === "listener_wake_delivered" && e.owner === agent.agentId)).toBe(true);
  } finally { if (child.exitCode === null) child.kill(9); await child.exited; await recovered?.stop(); fake.stop(); }
}, 15_000);

test("cost budget refuses unpriced requests and uses explicit per-model cache prices", async () => {
  const f = await setup(busy);
  try {
    const session = f.member.connection.session!, before = f.fake.requests.length;
    f.store.update({ budget: { maxCostUsd: 0.00004 } });
    await f.member.call("add_user_message", { text: "UNPRICED" }); await session.idle();
    expect(f.store.read().state).toBe("paused");
    // The lead receives a system notice, but the unpriced member request never reaches the server.
    expect(f.fake.requests.slice(before).some((r: any) => JSON.stringify(r.messages.at(-1)).includes("UNPRICED"))).toBe(false);
    const file = join(process.env.RIGWELL_HOME!, "settings.json"), settings = JSON.parse(readFileSync(file, "utf8"));
    settings.workstreams = { prices: { [session.settings.modelId]: { inputPerMtok: 1, cachedInputPerMtok: 1, outputPerMtok: 1, cacheWritePerMtok: 1 } } };
    writeFileSync(file, JSON.stringify(settings));
    await f.service.resume(f.store.id);
    await f.member.call("add_user_message", { text: "COSTED" }); await session.idle();
    expect(f.store.agent(f.first.agentId)!.costUsd).toBeCloseTo(0.00004, 10);
    expect(f.store.agent(f.first.agentId)!.costKnown).toBe(true);
    expect(f.store.read().state).toBe("paused");
  } finally { await f.close(); }
});

test("wall-time budget pauses an idle workstream without waiting for another model call", async () => {
  const f = await setup();
  try {
    f.store.update({ budget: { maxWallMinutes: 0 } });
    await until(() => f.store.read().state === "paused");
    expect(f.store.events().some((e) => e.type === "budget_reached" && e.reason === "maxWallMinutes")).toBe(true);
    await f.service.resume(f.store.id, { budget: { maxWallMinutes: 1 } });
    expect(f.store.read().state).toBe("active");
  } finally { await f.close(); }
});

test("explicit nested controls stop at depth two and descendant tool ceilings cannot be broadened", async () => {
  const f = await setup();
  try {
    f.store.update({ settings: { ...f.store.read().settings, allowNestedSpawn: true } });
    const parent = await f.service.spawn(f.lead.connection.session!, { name: "Parent", role: "task", prompt: "INITIAL", worktree: false, tools: ["Read", "Script", "SpawnAgent", "InterruptAgent", "ArchiveAgent", "SendMessage", "ListAgents"] });
    const parentSession = f.service.members.get(parent.agentId)!.connection.session!; await parentSession.idle();
    const child = await f.service.spawn(parentSession, { name: "Child", role: "task", prompt: "INITIAL", worktree: false, autonomyLevel: "high", tools: ["SpawnAgent", "Read", "Script", "Create"] });
    const member = f.service.members.get(child.agentId)!; await member.connection.session!.idle();
    expect(f.store.agent(child.agentId)).toMatchObject({ parentAgentId: parent.agentId, depth: 2, autonomyLevel: "low", tools: ["SpawnAgent", "Read", "Script"] });
    await member.call("update_session_settings", { restrictToolIds: ["Read", "Create", "Script", "SpawnAgent"], interactionMode: "mission", autonomyLevel: "high" });
    expect(member.connection.session!.tools().map((t) => t.name).sort()).toEqual(["Read", "Script"]);
    const script = member.connection.session!.tools().find((t) => t.name === "Script")!;
    const result = await script.run({ script: 'await Create({path:"forbidden-by-ceiling.txt",content:"blocked"})' }, { cwd: member.connection.session!.cwd, sessionId: child.sessionId, readFiles: new Map(), signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(existsSync(join(member.connection.session!.cwd, "forbidden-by-ceiling.txt"))).toBe(false);
    const error = await f.service.spawn(member.connection.session!, { name: "Too deep", role: "task", prompt: "INITIAL", worktree: false }).then(() => null, (e) => e);
    expect(error.message).toContain("depth cannot exceed 2");
    expect(f.store.roster().some((a) => a.name === "Too deep")).toBe(false);
    const controls = parentSession.tools().map((t) => t.name);
    expect(controls).toContain("InterruptAgent"); expect(controls).toContain("ArchiveAgent"); expect(controls).not.toContain("RenameAgent");
  } finally { await f.close(); }
});

test("a disconnected lead leaves member prompts pending for the user instead of refusing them", async () => {
  const f = await setup(busy);
  try {
    f.attached.close();
    await f.member.call("add_user_message", { text: "BUSY" });
    const session = f.member.connection.session!;
    await until(() => session.pendingPrompts().length === 1);
    expect(f.store.agent(f.first.agentId)!.status).toBe("waiting_input");
    expect(session.isRunning).toBe(true); expect(f.prompts).toHaveLength(0);
    const prompt = session.pendingPrompts()[0]!;
    expect(session.answerPrompt(prompt.requestId, { answers: [{ index: 1, question: "Continue?", answer: "yes" }] })).toBe(true);
    await session.idle(); expect(f.store.agent(f.first.agentId)!.status).toBe("idle");
  } finally { await f.close(); }
});

test("workstream archive cancels listeners and queued turns, and torn logs retain the next complete record", async () => {
  const f = await setup(busy);
  try {
    f.store.update({ settings: { ...f.store.read().settings, maxConcurrentAgents: 1 } });
    await f.member.call("add_user_message", { text: "BUSY" }); await until(() => f.prompts.length > 0);
    await f.service.spawn(f.lead.connection.session!, { name: "Queued", role: "task", prompt: "NEVER RUN", worktree: false });
    const listener = f.service.listeners.create(f.store, "lead", { on: "timer", filter: { afterMs: 60_000 } });
    const waiting = f.service.listeners.wait(f.store, "lead", { listenerIds: [listener.listenerId] });
    appendFileSync(f.store.path("events.jsonl"), '{"torn":');
    appendFileSync(f.store.path("messages.jsonl"), '{"torn":');
    const sent = f.service.send(f.lead.connection.session!.id, { to: "Queued", message: "DURABLE" });
    expect(f.store.messages().find((m) => m.id === sent.messageId)?.text).toBe("DURABLE");
    await f.service.archiveWorkstream(f.store.id);
    expect(await waiting).toEqual({ events: [], cancelled: true });
    expect(f.store.read().state).toBe("archived"); expect(f.store.listeners()).toEqual([]);
    expect(f.store.roster().every((a) => a.status === "archived")).toBe(true); expect(f.service.members.size).toBe(0);
    expect(f.store.events().at(-1)?.type).toBe("workstream_archived");
    expect(JSON.stringify(f.fake.requests)).not.toContain("NEVER RUN");
  } finally { await f.close(); }
});

test("a budget stop after a tool-producing response never opens a new permission prompt or executes the tool", async () => {
  const f = await setup((body) => JSON.stringify(body.messages.at(-1)).includes("BOUNDARY")
    ? { toolCalls: [{ name: "Execute", input: { command: "echo forbidden > budget-forbidden.txt", riskLevel: "high", riskReason: "writes a file" } }], usage: { input: 10, output: 5, cacheRead: 2, cacheCreation: 3 } }
    : { text: "Finished" });
  try {
    f.store.update({ budget: { maxTokens: f.store.agent(f.first.agentId)!.tokens + 20 } });
    await f.member.call("add_user_message", { text: "BOUNDARY" }); await f.member.connection.session!.idle();
    expect(f.store.read().state).toBe("paused"); expect(f.store.agent(f.first.agentId)!.status).toBe("interrupted");
    expect(f.prompts).toHaveLength(0); expect(f.member.connection.session!.pendingPrompts()).toHaveLength(0);
    expect(existsSync(join(f.cwd, "budget-forbidden.txt"))).toBe(false);
    expect(JSON.stringify(f.member.connection.session!.uiMessages())).toContain("Not run: the turn was stopped");
  } finally { await f.close(); }
});

test("closing a loaded view twice cannot release the persistent member's independent worktree hold", async () => {
  const f = await setup();
  const view = new MemberSession({ tools: (t) => t, notify() {}, request: async () => ({ trust: true }) });
  try {
    const repo = makeGitRepo(), agent = await f.service.spawn(f.lead.connection.session!, { name: "Live owner", role: "task", prompt: "INITIAL", cwd: repo });
    await f.service.members.get(agent.agentId)!.connection.session!.idle();
    await view.call("load_session", { sessionId: agent.sessionId, cwd: agent.worktreePath });
    await view.call("close_session"); await view.close();
    const manager = managerFor(loadSettings({ cwd: repo }).settings);
    const error = await manager.remove(agent.worktreePath!).then(() => null, (e) => e);
    expect(error.code).toBe("in_use"); expect(existsSync(agent.worktreePath!)).toBe(true);
    expect(await f.service.archive(f.lead.connection.session!.id, { agentId: agent.agentId, cleanupWorktree: true })).toEqual({ archived: true, worktreeKept: false });
    expect(existsSync(agent.worktreePath!)).toBe(false);
  } finally { await view.close(); await f.close(); }
}, 15_000);
