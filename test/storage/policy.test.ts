import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpEnv, writeJson } from "./helpers.ts";
import { effectivePolicy, loadPolicies, policyPaths, validatePolicy } from "../../src/storage/policy.ts";
import { loadSettings } from "../../src/storage/settings.ts";
import { resolveModels } from "../../src/storage/models.ts";
import { loadHooksConfig } from "../../src/hooks/config.ts";
import { runHooks } from "../../src/hooks/runner.ts";
import { McpManager } from "../../src/mcp/manager.ts";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { Session } from "../../src/agent/session.ts";
import { createMissionService } from "../../src/missions/index.ts";
import { MissionStore, missionDirFor } from "../../src/missions/store.ts";
import { zeroUsage } from "../../src/core/types.ts";
import type { WorkerOutcome } from "../../src/missions/worker.ts";

test("local/system policies intersect restrictions and reject malformed or linked authority", () => {
  const env = tmpEnv(), local = join(env.root, "local.json"), system = join(env.root, "system.json");
  try {
    writeJson(local, { schemaVersion: 1, maxAutonomyLevel: "low", modelPolicy: { allowedModelIds: ["one", "two"], blockedModelIds: ["three"] }, workstreams: { maxMembers: 2, enabled: false }, mcpServerAllowlist: [] });
    writeJson(system, { schemaVersion: 1, maxAutonomyLevel: "medium", modelPolicy: { allowedModelIds: ["two", "three"] }, workstreams: { maxMembers: 5, enabled: true } });
    const p = effectivePolicy({}, loadPolicies({}, [local, system])); expect(p.maxAutonomyLevel).toBe("low"); expect(p.modelPolicy).toMatchObject({ allowedModelIds: ["two"], blockedModelIds: ["three"] }); expect(p.workstreams).toEqual({ maxMembers: 2, enabled: false }); expect(p.mcpServerAllowlist).toEqual([]);
    expect(policyPaths({ RIGWELL_HOME: env.rigwellHome }, "linux")).toEqual([join(env.rigwellHome, "policy.json"), "/etc/rigwell/policy.json"]);
    expect(policyPaths({ RIGWELL_HOME: env.rigwellHome, ProgramData: env.root }, "win32")[1]).toBe(join(env.root, "Rigwell", "policy.json"));
    for (const bad of [{ schemaVersion: 1, typo: true }, { schemaVersion: 1, modelPolicy: { allowedModelIds: null } }, { schemaVersion: 1, missions: { maxFeatures: -1 } }, { schemaVersion: 1, requiredHooks: { InvalidEvent: [] } }]) expect(() => validatePolicy(bad)).toThrow();
    writeFileSync(system, "broken"); expect(() => loadPolicies({}, [system])).toThrow("Invalid policy");
    const link = join(env.root, "link.json"); symlinkSync(local, link, "file"); expect(() => loadPolicies({}, [link])).toThrow("unlinked");
  } finally { env.cleanup(); }
});

test("policy beats runtime/project settings and model selection over the actual protocol", async () => {
  const env = tmpEnv(), client = new MemberSession({ notify() {}, tools: (t) => t, request: async () => ({ selectedOption: "cancel" }) });
  try {
    const models = ["allowed", "denied"].map((model) => ({ model, displayName: model, provider: "anthropic", baseUrl: "http://127.0.0.1:1", apiKey: "fake-only" }));
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: models, sessionDefaultSettings: { autonomyLevel: "high" } });
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, modelPolicy: { allowedModelIds: ["allowed", "denied"], blockedModelIds: ["denied"] }, maxAutonomyLevel: "low" });
    mkdirSync(join(env.root, ".rigwell")); writeJson(join(env.root, ".rigwell", "settings.json"), { modelPolicy: { blockedModelIds: [] }, maxAutonomyLevel: "high" });
    const runtime = join(env.root, "runtime.json"); writeJson(runtime, { modelPolicy: { allowedModelIds: ["denied"] }, sessionDefaultSettings: { autonomyLevel: "high" } });
    const loaded = loadSettings({ cwd: env.root, runtimeSettingsPath: runtime }); expect(resolveModels(loaded.settings).map((m) => m.model)).toEqual(["allowed"]); expect(loaded.settings.sessionDefaultSettings?.autonomyLevel).toBe("low"); expect(loaded.managedKeys).toContain("modelPolicy");
    const refused = await client.call("initialize_session", { cwd: env.root, modelId: "custom:denied-1" }).then(() => null, (e) => e); expect(refused.message).toMatch(/model/i);
    await client.call("initialize_session", { cwd: env.root, modelId: "custom:allowed-0", autonomyLevel: "high" }); expect(client.connection.session!.settings.autonomyLevel).toBe("low");
    await client.call("update_session_settings", { autonomyLevel: "high" }); expect(client.connection.session!.settings.autonomyLevel).toBe("low");
  } finally { await client.close(); env.cleanup(); }
});

test("a required hook really executes while lower-level hooks are disabled", async () => {
  const env = tmpEnv(), script = join(env.root, "hook.ts"), marker = join(env.root, "ran.txt");
  try {
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "required");`);
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, requiredHooks: { SessionStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${script}"` }] }] } });
    writeJson(join(env.rigwellHome, "settings.json"), { hooksDisabled: true, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "must-not-execute" }] }] } });
    const config = loadHooksConfig({ cwd: env.root }); expect(config.hooksDisabled).toBe(true);
    const result = await runHooks(config, "SessionStart", { session_id: "policy-fixture", transcript_path: "", cwd: env.root, permission_mode: "off" }, {});
    expect(result.ran).toBe(true); expect(result.results).toHaveLength(1); expect(result.results[0]?.exitCode).toBe(0); expect(readFileSync(marker, "utf8")).toBe("required");
  } finally { env.cleanup(); }
});

test("MCP policy pins launch arguments/environment, blocks additions before persistence and rechecks live calls", async () => {
  const env = tmpEnv(), mgr = new McpManager({ cwd: env.root });
  const cfg = { name: "fixture", type: "stdio" as const, command: process.execPath, args: [resolve(import.meta.dir, "../fakes/fake-mcp-server.ts")], env: { FAKE_MCP_NAME: "fixture" }, source: "session" as const };
  const { source, ...launch } = cfg;
  try {
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, mcpServerAllowlist: [launch] });
    await mgr.start([cfg]); expect((await mgr.callTool("fixture__echo", { text: "allowed" })).text).toBe("allowed");
    const blocked = await mgr.addServer({ ...cfg, args: ["must-not-launch"] }).then(() => null, (e) => e); expect(blocked.message).toContain("blocked by policy"); expect(existsSync(join(env.rigwellHome, "mcp.json"))).toBe(false);
    await mgr.start([{ ...cfg, name: "different", env: { FAKE_MCP_NAME: "different" } }]); expect(mgr.listServers().servers.find((s) => s.name === "different")?.status).toBe("failed");
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, mcpServerAllowlist: [] });
    const changed = await mgr.callTool("fixture__echo", {}).then(() => null, (e) => e); expect(changed.message).toContain("blocked by policy");
  } finally { await mgr.shutdown(); env.cleanup(); }
});

test("the actual agent loop cannot bypass a required blocking tool hook with hooksDisabled", async () => {
  const env = tmpEnv(), marker = join(env.root, "required-ran"), script = join(env.root, "block.ts");
  const fake = await startFakeAnthropic([{ toolCalls: [{ name: "Read", input: { path: "fixture.txt" } }] }, { text: "The hook blocked the read." }]);
  const member = new MemberSession({ notify() {}, request: async () => ({ selectedOption: "proceed_once" }), tools: (t) => t });
  try {
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stderr.write("Required fixture hook blocked this action"); process.exit(2);`); writeFileSync(join(env.root, "fixture.txt"), "MUST-NOT-REACH-PROVIDER");
    writeJson(join(env.rigwellHome, "settings.json"), { hooksDisabled: true, customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }] });
    writeJson(join(env.rigwellHome, "policy.json"), { schemaVersion: 1, requiredHooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `"${process.execPath}" "${script}"` }] }] } });
    await member.call("initialize_session", { cwd: env.root, modelId: "custom:Fixture-0", autonomyLevel: "low" }); await member.call("add_user_message", { text: "Read fixture.txt" }); await member.connection.session!.idle();
    expect(existsSync(marker)).toBe(true); expect(fake.requests).toHaveLength(2); expect(JSON.stringify(fake.requests[1])).toContain("Required fixture hook blocked"); expect(JSON.stringify(fake.requests)).not.toContain("MUST-NOT-REACH-PROVIDER");
  } finally { await member.close(); fake.stop(); env.cleanup(); }
});

test("actual Workstream members respect count, turn concurrency, resumed admission and disabled policy", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic(Array.from({ length: 12 }, () => ({ text: "Done" }))), service = createWorkstreamService({ recover: false });
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }], workstreams: { maxConcurrentAgents: 8, allowNestedSpawn: true } });
    const policyFile = join(env.rigwellHome, "policy.json"), policy = { schemaVersion: 1, workstreams: { maxMembers: 1, maxActive: 1, maxConcurrentAgents: 1, allowNestedSpawn: false } }; writeJson(policyFile, policy);
    const lead = { id: crypto.randomUUID(), cwd: env.root, settings: { modelId: "custom:Fixture-0", reasoningEffort: "low", autonomyLevel: "low" }, uiMessages: () => [] } as unknown as Session;
    const conn = { session: () => lead, notify() {}, request: async () => ({ selectedOption: "proceed_once" }) };
    const proposal = { title: "Policy fixture", goal: "Observe admission", plan: "One member" }, approved = await service.propose(conn, proposal), store = new WorkstreamStore(approved.workstreamId!);
    expect(store.read().settings.maxConcurrentAgents).toBe(1);
    const first = await service.spawn(lead, { name: "First", role: "fixture", prompt: "Return Done", worktree: false }); await service.members.get(first.agentId)!.connection.session!.idle();
    const extra = await service.spawn(lead, { name: "Extra", role: "fixture", prompt: "Never execute", worktree: false }).then(() => null, (e) => e); expect(extra.message).toContain("maxMembers"); expect(fake.requests).toHaveLength(1);
    const other = { ...lead, id: crypto.randomUUID() } as Session;
    const active = await service.propose({ ...conn, session: () => other }, proposal).then(() => null, (e) => e); expect(active.message).toContain("policy");
    service.pause(store.id); writeJson(policyFile, { schemaVersion: 1, workstreams: { enabled: false } });
    const resumed = await service.resume(store.id).then(() => null, (e) => e); expect(resumed.message).toContain("policy"); expect(store.read().state).toBe("paused"); expect(fake.requests).toHaveLength(1);
  } finally { await service.stop(); fake.stop(); env.cleanup(); }
}, 15_000);

test("mission service reserves concurrency before workers and cannot grant attempts above policy", async () => {
  const env = tmpEnv(), running: { interrupt(): void }[] = [];
  const service = createMissionService({ lockSpawner: () => undefined, spawn: (request) => {
    let finish!: (outcome: WorkerOutcome) => void;
    const done = new Promise<WorkerOutcome>((resolve) => { finish = resolve; });
    const interrupt = () => finish({ status: "interrupted", interruptReason: "pause", text: "", messages: [], tokenUsage: zeroUsage() });
    running.push({ interrupt }); return { sessionId: request.sessionId, done, interrupt };
  } });
  let firstRun: Promise<unknown> | undefined;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: "http://127.0.0.1:1", apiKey: "fake-only" }] });
    const policy = join(env.rigwellHome, "policy.json"); writeJson(policy, { schemaVersion: 1, missions: { maxConcurrentRuns: 1, maxWorkerAttempts: 1 } });
    const prepare = (prior: string[]) => {
      const session = { id: crypto.randomUUID(), cwd: env.root, settings: { interactionMode: "mission", modelId: "custom:Fixture-0", reasoningEffort: "low" }, tokenUsage: zeroUsage(), onAskUser() {}, subscribeNotifications() { return () => {}; } } as unknown as Session;
      const store = new MissionStore(missionDirFor(session.id)); store.ensure(); store.writeState({ state: "planning", workingDirectory: env.root });
      store.writeFeatures([{ id: "feature", description: "Fixture", skillName: "impl", milestone: "one", status: "pending", workerSessionIds: prior }]);
      writeFileSync(store.path("validation-contract.md"), "Fixture contract"); writeJson(store.path("validation-state.json"), { assertions: {} });
      mkdirSync(store.path("skills", "impl")); writeFileSync(store.path("skills", "impl", "SKILL.md"), "---\nname: impl\ndescription: Fixture worker\n---\nDo fixture work.\n");
      const attached = service.attach({ session: () => session, notify() {} });
      const start = attached.wrapTools([]).find((t) => t.name === "StartMissionRun")!;
      return { store, attached, start };
    };
    const first = prepare(["prior-attempt"]), second = prepare([]), ctx = { signal: new AbortController().signal } as any;
    const capped = await first.start.run({}, ctx); expect(capped.data).toMatchObject({ state: "paused", pauseReason: "feature_retry_limit_exceeded" }); expect(running).toHaveLength(0);
    writeJson(policy, { schemaVersion: 1, missions: { maxConcurrentRuns: 1, maxWorkerAttempts: 2 } });
    firstRun = Promise.resolve(first.start.run({}, ctx));
    const deadline = Date.now() + 2000; while (!running.length && Date.now() < deadline) await Bun.sleep(1);
    expect(running).toHaveLength(1); expect(service.handles.size).toBe(1);
    const refused = await Promise.resolve(second.start.run({}, ctx)).then(() => null, (e) => e); expect(refused.message).toContain("concurrency"); expect(running).toHaveLength(1);
    first.attached.methods.mission_pause({}); await firstRun; expect(service.handles.size).toBe(0);
  } finally { for (const worker of running) worker.interrupt(); await firstRun; env.cleanup(); }
}, 10000);
