import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import { WorkstreamStore, listWorkstreamStores, workstreamsRoot } from "../../src/workstreams/store.ts";
import type { Session } from "../../src/agent/session.ts";
import { resolveModels } from "../../src/storage/models.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { makeHome } from "../e2e/helpers.ts";
import { MODEL } from "../desktop/helpers.ts";
import { makeGitRepo, tmp } from "../worktree/util.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { connect } from "../desktop/helpers.ts";

const proposal = { title: "Local task", goal: "Fix the fixture", plan: "Two independent members" };
const lead = (cwd: string) => ({ id: crypto.randomUUID(), cwd, settings: { modelId: resolveModels(loadSettings({ cwd }).settings)[0]?.id ?? MODEL, reasoningEffort: "low", autonomyLevel: "low" } }) as unknown as Session;
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() >= end) throw new Error("condition not reached"); await Bun.sleep(5); }
}

test("proposal rejects or lacks an approver without creating state or spawning", async () => {
  process.env.RIGWELL_HOME = tmp("ws-reject");
  const service = createWorkstreamService(), session = lead(tmp("ws-cwd"));
  try {
    expect(await service.propose({ session: () => session, notify() {} }, proposal)).toMatchObject({ accepted: false });
    expect(await service.propose({ session: () => session, notify() {}, request: async () => ({ selectedOption: "cancel" }) }, proposal)).toEqual({ accepted: false });
    expect(listWorkstreamStores()).toEqual([]); expect(service.members.size).toBe(0);
  } finally { await service.stop(); }
});

test("accepted edited proposal persists the shared folder, atomic roster and lifecycle log", async () => {
  process.env.RIGWELL_HOME = tmp("ws-accept");
  const service = createWorkstreamService(), session = lead(tmp("ws-cwd"));
  try {
    const result = await service.propose({ session: () => session, notify() {}, request: async (_method, p: any) => {
      expect(p.toolUses[0].confirmationType).toBe("propose_workstream");
      return { selectedOption: "proceed_edit", editedSpecContent: "Edited plan" };
    } }, proposal);
    expect(result).toMatchObject({ accepted: true, isEdited: true, editedPlan: "Edited plan" });
    const store = new WorkstreamStore(result.workstreamId!);
    expect(store.read()).toMatchObject({ title: proposal.title, goal: proposal.goal, plan: "Edited plan", state: "active", leadSessionId: session.id });
    expect(store.roster()).toEqual([]); expect(existsSync(store.path("shared"))).toBe(true);
    expect(store.events().map((e) => e.type)).toEqual(["workstream_accepted"]);
    expect(readdirSync(store.dir).sort()).toEqual(["events.jsonl", "listeners.json", "messages.jsonl", "roster.json", "shared", "workstream.json"]);
    expect(() => new WorkstreamStore("../escape")).toThrow("Invalid workstream id");
  } finally { await service.stop(); }
});

test("two real member sessions use separate worktrees, stay live when idle, and cap autonomy", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 20 }, () => ({ text: "Member task completed" })));
  const home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  process.env.RIGWELL_HOME = home;
  const repo = makeGitRepo(), session = lead(repo), service = createWorkstreamService();
  const conn = { session: () => session, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) };
  const attached = service.attach(conn);
  try {
    const approved = await service.propose(conn, proposal), store = new WorkstreamStore(approved.workstreamId!);
    const one = await service.spawn(session, { name: "First", role: "implementation", prompt: "Handle first part", autonomyLevel: "high" });
    const two = await service.spawn(session, { name: "Second", role: "verification", prompt: "Handle second part" });
    expect(one.worktreePath).toBeTruthy(); expect(two.worktreePath).toBeTruthy(); expect(one.worktreePath).not.toBe(two.worktreePath);
    expect(one.worktreePath).not.toBe(repo);
    await until(() => store.roster().every((a) => a.status === "idle" && a.lastSummary?.includes("completed")));
    expect(service.members.size).toBe(2);
    const roster = store.roster(); expect(roster.map((a) => a.autonomyLevel)).toEqual(["low", "low"]);
    expect(roster.every((a) => a.branch && a.cwd === a.worktreePath)).toBe(true);
    writeFileSync(join(one.worktreePath!, "private.txt"), "member one");
    expect(existsSync(join(two.worktreePath!, "private.txt"))).toBe(false); expect(existsSync(join(repo, "private.txt"))).toBe(false);
    const member = service.members.get(one.agentId)!;
    await member.call("update_session_settings", { autonomyLevel: "high", interactionMode: "mission" });
    expect(member.connection.session!.settings.autonomyLevel).toBe("low");
    const leadTools = attached.wrapTools([]); expect(leadTools.map((t) => t.name)).toEqual(["ProposeWorkstream", "SpawnAgent", "ListAgents", "SendMessage"]);
    expect((await leadTools.find((t) => t.name === "ListAgents")!.run({}, {} as any)).data).toMatchObject({ agents: [{ name: "First" }, { name: "Second" }] });
    const prompt = JSON.stringify(fake.requests);
    expect(prompt).toContain(store.path("shared").replace(/\\/g, "\\\\"));
    expect(store.events().filter((e) => e.type === "agent_spawned")).toHaveLength(2);
    expect(readFileSync(store.path("roster.json"), "utf8")).toContain(one.sessionId);
  } finally { attached.close(); await service.stop(); fake.stop(); }
}, 15_000);

test("members cannot spawn members or propose their own workstreams", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 10 }, () => ({ text: "Member done" })));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const session = lead(tmp("ws-plain")), service = createWorkstreamService();
  const conn = { session: () => session, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) };
  service.attach(conn);
  try {
    await service.propose(conn, proposal);
    const a = await service.spawn(session, { name: "Member", role: "task", prompt: "Work", worktree: false });
    const member = service.members.get(a.agentId)!.connection.session!;
    const error = await service.spawn(member, { name: "Nested", role: "task", prompt: "Work" }).then(() => null, (e) => e);
    expect(error.message).toContain("Only the lead");
    const rejected = await service.propose({ session: () => member, notify() {} }, proposal).then(() => null, (e) => e);
    expect(rejected.message).toContain("Members cannot propose");
    expect(fake.requests.some((r: any) => r.tools?.some((t: any) => t.name === "SpawnAgent"))).toBe(false);
  } finally { await service.stop(); fake.stop(); }
}, 10_000);

test("a lead creates a Workstream through real daemon tools and spawns two persistent members", async () => {
  const route = (body: any): any => {
    if (!body.tools?.length) return { text: "Fixture title" };
    const text = JSON.stringify(body.messages);
    if (!text.includes("LEAD_PLAN")) return { text: "Member done" };
    const calls = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "tool_use") : []);
    if (!calls.some((c: any) => c.name === "ProposeWorkstream")) return { toolCalls: [{ name: "ProposeWorkstream", input: proposal }] };
    const count = calls.filter((c: any) => c.name === "SpawnAgent").length;
    if (count < 2) return { toolCalls: [{ name: "SpawnAgent", input: { name: `Member ${count + 1}`, role: "task", prompt: "Member task" } }] };
    return { text: "Lead done" };
  };
  const fake = await startFakeAnthropic(Array.from({ length: 30 }, () => route));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const repo = makeGitRepo();
  const daemon = await startDaemon({ socketPath: join(tmp("ws-socket"), "daemon.sock"), automations: false, sidepane: false, ws: false });
  const client = await connect(daemon.socketPath);
  let approvals = 0;
  client.rpc.onRequest = (method, p: any) => {
    if (method === "request_permission") { expect(p.toolUses[0].confirmationType).toBe("propose_workstream"); approvals++; return { selectedOption: "proceed_once" }; }
    return { trust: false };
  };
  try {
    await client.call("initialize_session", { cwd: repo, modelId: lead(repo).settings.modelId, autonomyLevel: "low" });
    await client.call("add_user_message", { text: "LEAD_PLAN" });
    await client.waitFor((n) => n.type === "agent_turn_completed", 10_000);
    const stores = listWorkstreamStores(); expect(stores).toHaveLength(1);
    expect(approvals).toBe(1); expect(stores[0]!.roster()).toHaveLength(2);
    await until(() => stores[0]!.roster().every((a) => a.status === "idle"));
    expect(daemon.workstreams.members.size).toBe(2);
    expect(stores[0]!.roster().every((a) => !!a.worktreePath)).toBe(true);
  } finally { await daemon.workstreams.stop(); await client.close(); daemon.stop(); fake.stop(); }
}, 15_000);

test("member permission requests reach the user with member labels and honor cancellation", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 12 }, () => (body: any): any => {
    if (!body.tools?.length) return { text: "Fixture title" };
    const last = body.messages.at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((c: any) => c.type === "tool_result");
    return hasResult ? { text: "Cancelled action acknowledged" } : { toolCalls: [{ name: "Execute", input: { command: "echo unsafe > forbidden.txt", riskLevel: "high", riskReason: "writes a file" } }] };
  }));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const cwd = tmp("ws-prompt"), session = lead(cwd), service = createWorkstreamService();
  const prompts: any[] = [];
  const conn = { session: () => session, notify() {}, request: async (_method: string, p: any) => {
    if (p.toolUses?.[0]?.confirmationType === "propose_workstream") return { selectedOption: "proceed_once" };
    prompts.push(p); return { selectedOption: "cancel" };
  } };
  service.attach(conn);
  try {
    const approved = await service.propose(conn, proposal);
    const agent = await service.spawn(session, { name: "Careful member", role: "task", prompt: "Try the action", worktree: false });
    await until(() => prompts.length === 1);
    expect(prompts[0]).toMatchObject({ workstreamId: approved.workstreamId, agentId: agent.agentId, agentName: "Careful member", workstreamTitle: proposal.title });
    await service.members.get(agent.agentId)!.connection.session!.idle();
    await service.members.get(agent.agentId)!.call("update_session_settings", { interactionMode: "mission", autonomyLevel: "high" });
    await service.members.get(agent.agentId)!.call("add_user_message", { text: "Try again in mission mode" });
    await until(() => prompts.length === 2);
    await service.members.get(agent.agentId)!.connection.session!.idle();
    expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
  } finally { await service.stop(); fake.stop(); }
}, 10_000);


test("failed member status survives the session's final idle notification", async () => {
  const fake = await startFakeAnthropic(Array.from({ length: 12 }, () => ({ status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "fixture failure" } } })));
  process.env.RIGWELL_HOME = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fixture" }]);
  const session = lead(tmp("ws-failed")), service = createWorkstreamService();
  const conn = { session: () => session, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) };
  service.attach(conn);
  try {
    const approved = await service.propose(conn, proposal), store = new WorkstreamStore(approved.workstreamId!);
    const agent = await service.spawn(session, { name: "Failing", role: "task", prompt: "Fail", worktree: false });
    await service.members.get(agent.agentId)!.connection.session!.idle();
    expect(store.agent(agent.agentId)!.status).toBe("failed");
  } finally { await service.stop(); fake.stop(); }
});
