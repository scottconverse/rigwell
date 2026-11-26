import { expect, test } from "bun:test";
import { linkSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../../src/core/types.ts";
import type { Session } from "../../src/agent/session.ts";
import { createApplyPatchTool } from "../../src/tools/apply-patch.ts";
import { createCreateTool } from "../../src/tools/create.ts";
import { findModel, resolveModels } from "../../src/storage/models.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { approvedWriteScopes, guardMemberWrites } from "../../src/workstreams/write-scope.ts";
import { makeHome } from "../e2e/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeTurnSpec } from "../fakes/types.ts";
import { makeGitRepo, tmp } from "../worktree/util.ts";

test("write assignments reject traversal, alternate streams and missing member boundaries", () => {
  expect(approvedWriteScopes([{ name: "Parser", writeFiles: ["src\\csv.js"] }, { name: "Reviewer", writeFiles: [] }])).toEqual([
    { name: "Parser", writeFiles: ["src/csv.js"] }, { name: "Reviewer", writeFiles: [] },
  ]);
  for (const path of ["../other", "/abs", "C:\\abs", "own.txt:stream", ".git/config", "docs.", "aux.log"]) {
    expect(() => approvedWriteScopes([{ name: "Parser", writeFiles: [path] }])).toThrow("Unsafe or non-relative");
  }
  expect(() => approvedWriteScopes([{ name: "Parser", writeFiles: [] }, { name: "Reviewer" }])).toThrow("every member");
});

test("mixed patches and hard-linked destinations are denied before any write", async () => {
  const cwd = tmp("ws-write-scope"), outside = join(tmp("ws-write-source"), "outside.txt");
  writeFileSync(outside, "intact");
  linkSync(outside, join(cwd, "linked.txt"));
  const ctx: ToolContext = { cwd, sessionId: "test", readFiles: new Map(), signal: new AbortController().signal };
  const denials: string[][] = [];
  const denied = (paths: string[]) => denials.push(paths);
  const create = guardMemberWrites(createCreateTool(), ["linked.txt"], denied);
  expect((await create.run({ path: "linked.txt", overwrite: true, content: "unexpected" }, ctx)).isError).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("intact");

  const patch = guardMemberWrites(createApplyPatchTool(), ["owned.txt"], denied);
  const input = "*** Begin Patch\n*** Add File: owned.txt\n+permitted\n*** Add File: unassigned.txt\n+denied\n*** End Patch";
  expect((await patch.run({ input }, ctx)).isError).toBe(true);
  expect(() => readFileSync(join(cwd, "owned.txt"))).toThrow();
  expect(denials).toEqual([["linked.txt"], ["owned.txt", "unassigned.txt"]]);
});

const scopedProposal = { title: "Scoped task", goal: "Fix the fixture", plan: "One scoped member" };
type ModelSpecs = Parameters<typeof makeHome>[0];

const directSpec = (url: string): ModelSpecs[number] => ({ provider: "anthropic", url, displayName: "Direct" });
const signedInSpec = (url: string): ModelSpecs[number] => ({ provider: "anthropic", url, displayName: "Signed-in",
  extra: { apiKey: undefined, executionBackend: "claude-cli", cliExecutable: process.execPath } });

function leadSession(cwd: string, modelId: string): Session {
  return { id: crypto.randomUUID(), cwd, uiMessages: () => [], settings: { modelId, reasoningEffort: "low", autonomyLevel: "low" } } as unknown as Session;
}

async function scopedHarness(script: FakeTurnSpec[], specs: (url: string) => ModelSpecs, leadDisplay: string) {
  const fake = await startFakeAnthropic(Array.from({ length: 40 }, (_, i) => script[Math.min(i, script.length - 1)]!));
  process.env.RIGWELL_HOME = makeHome(specs(fake.url));
  const cwd = makeGitRepo();
  const models = resolveModels(loadSettings({ cwd }).settings);
  const leadModel = models.find((m) => m.displayName === leadDisplay)!;
  const session = leadSession(cwd, leadModel.id);
  const service = createWorkstreamService(), notifications: any[] = [];
  const conn = { session: () => session, notify: (n: any) => notifications.push(n), request: async () => ({ selectedOption: "proceed_once" }) };
  const attached = service.attach(conn);
  return { fake, cwd, models, leadModel, session, service, conn, notifications,
    async close() { attached.close(); await service.stop(); fake.stop(); } };
}

test("a scoped member on a signed-in default swaps to a direct model and runs", async () => {
  const h = await scopedHarness([{ text: "Work complete" }], (url) => [directSpec(url), signedInSpec(url)], "Signed-in");
  try {
    const direct = findModel(h.models, h.models.find((m) => m.displayName === "Direct")!.id)!;
    const signedIn = h.leadModel;
    const approved = await h.service.propose(h.conn, { ...scopedProposal, agents: [{ name: "Writer", writeFiles: ["owned.txt"] }] });
    const store = new WorkstreamStore(approved.workstreamId!);
    const result = await h.service.spawn(h.session, { name: "Writer", role: "task", prompt: "Write owned.txt" });
    expect(result.modelNote).toBe("The signed-in client cannot keep a member to its approved files, so this member uses Direct instead.");
    expect(store.agent(result.agentId)!.model).toBe(direct.id);
    expect(store.events().find((e) => e.type === "member_model_swapped")).toMatchObject({ agentId: result.agentId, from: signedIn.id, to: direct.id });
    await h.service.members.get(result.agentId)!.connection.session!.idle();
    expect(store.agent(result.agentId)).toMatchObject({ status: "idle", lastSummary: "Work complete" });
  } finally { await h.close(); }
}, 15_000);

test("a scoped member refuses before any roster row or worktree when no direct model is set up", async () => {
  const h = await scopedHarness([{ text: "Never runs" }], (url) => [signedInSpec(url)], "Signed-in");
  try {
    const approved = await h.service.propose(h.conn, { ...scopedProposal, agents: [{ name: "Writer", writeFiles: ["owned.txt"] }] });
    const store = new WorkstreamStore(approved.workstreamId!);
    await expect(h.service.spawn(h.session, { name: "Writer", role: "task", prompt: "Write owned.txt" }))
      .rejects.toThrow("A member with approved write files needs a direct model. The signed-in client cannot keep a member to its approved files. Add a direct model (an API key or a local or cloud model server) in Settings, Models.");
    expect(store.roster()).toEqual([]);
    expect(h.service.members.size).toBe(0);
  } finally { await h.close(); }
}, 15_000);

test("an unscoped member on a signed-in model is not swapped", async () => {
  const h = await scopedHarness([{ text: "Plain work" }], (url) => [directSpec(url), signedInSpec(url)], "Signed-in");
  try {
    const approved = await h.service.propose(h.conn, scopedProposal);
    const store = new WorkstreamStore(approved.workstreamId!);
    const result = await h.service.spawn(h.session, { name: "Plain", role: "task", prompt: "Plain task", worktree: false });
    expect(result.modelNote).toBeUndefined();
    expect(store.agent(result.agentId)!.model).toBe(h.leadModel.id);
    expect(store.events().some((e) => e.type === "member_model_swapped")).toBe(false);
    h.service.members.get(result.agentId)!.view?.interrupt(true);
    await h.service.members.get(result.agentId)!.connection.session!.idle().catch(() => {});
  } finally { await h.close(); }
}, 15_000);

test("a scoped member already on a direct model is unchanged", async () => {
  const h = await scopedHarness([{ text: "Direct work" }], (url) => [directSpec(url)], "Direct");
  try {
    const approved = await h.service.propose(h.conn, { ...scopedProposal, agents: [{ name: "Writer", writeFiles: ["owned.txt"] }] });
    const store = new WorkstreamStore(approved.workstreamId!);
    const result = await h.service.spawn(h.session, { name: "Writer", role: "task", prompt: "Write owned.txt" });
    expect(result.modelNote).toBeUndefined();
    expect(store.agent(result.agentId)!.model).toBe(h.leadModel.id);
    expect(store.events().some((e) => e.type === "member_model_swapped")).toBe(false);
    await h.service.members.get(result.agentId)!.connection.session!.idle();
    expect(store.agent(result.agentId)).toMatchObject({ status: "idle", lastSummary: "Direct work" });
  } finally { await h.close(); }
}, 15_000);

test("a failed member turn keeps the thrown error text in lastSummary", async () => {
  const h = await scopedHarness([{ status: 400, errorBody: { type: "error", error: { type: "invalid_request_error", message: "fixture failure" } } }],
    (url) => [directSpec(url)], "Direct");
  try {
    const approved = await h.service.propose(h.conn, scopedProposal);
    const store = new WorkstreamStore(approved.workstreamId!);
    const result = await h.service.spawn(h.session, { name: "Failing", role: "task", prompt: "Fail", worktree: false });
    await h.service.members.get(result.agentId)!.connection.session!.idle();
    const memberNotes = h.notifications.filter((n) => n.type === "workstream_member_notification" && n.agentId === result.agentId).map((n) => n.notification);
    const errorNote = memberNotes.findIndex((n) => n.type === "error");
    expect(errorNote).toBeGreaterThanOrEqual(0);
    expect(memberNotes[errorNote].message).toContain("fixture failure");
    expect(memberNotes.findIndex((n) => n.type === "agent_turn_completed")).toBeGreaterThan(errorNote);
    expect(store.agent(result.agentId)!.status).toBe("failed");
    expect(store.agent(result.agentId)!.lastSummary).toContain("fixture failure");
  } finally { await h.close(); }
}, 15_000);

test("assigned files can be created through the system temp path but not through worktree junctions or symlinks", async () => {
  const cwd = tmp("ws-assigned-root");
  const linked = join(tmp("ws-linked-root"), "worktree");
  symlinkSync(realpathSync(cwd), linked, process.platform === "win32" ? "junction" : "dir");
  const ctx: ToolContext = { cwd, sessionId: "test", readFiles: new Map(), signal: new AbortController().signal };
  const create = guardMemberWrites(createCreateTool(), ["owned.txt"], () => {});
  expect((await create.run({ path: "owned.txt", content: "allowed" }, ctx)).isError).not.toBe(true);
  expect((await create.run({ path: "owned.txt", overwrite: true, content: "unexpected" }, { ...ctx, cwd: linked })).isError).toBe(true);
  expect(readFileSync(join(cwd, "owned.txt"), "utf8")).toBe("allowed");
});
