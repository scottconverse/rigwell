import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { parseFeatures } from "../../src/features/config.ts";
import { featureEnabled, readFeatures } from "../../src/features/features.ts";
import { updateUserSettings } from "../../desktop/main/user-settings.ts";
import { MemberSession } from "../../src/workstreams/member.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { setup } from "../workstreams/helpers.ts";
import { workstreamSettings } from "../../src/workstreams/index.ts";

test("registered local feature flags default off, preserve explicit legacy opt-ins and validate before settings writes", () => {
  const env = tmpEnv(), prior = process.env.RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH;
  try {
    delete process.env.RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH; expect(readFeatures().features.every((f) => !f.enabled && f.source === "default off")).toBe(true);
    updateUserSettings(env.rigwellHome, { allowSubagentsInScripts: true, workstreams: { allowNestedSpawn: true } }); expect(readFeatures().features.every((f) => f.enabled && f.source === "legacy opt-in")).toBe(true);
    updateUserSettings(env.rigwellHome, { features: { script_subagents: false, nested_workstreams: false } }); const before = readFileSync(join(env.rigwellHome, "settings.json"), "utf8");
    for (const value of [[], "on", { arbitrary: true }, { script_subagents: "true" }, new Date()]) expect(() => updateUserSettings(env.rigwellHome, { features: value })).toThrow(); expect(readFileSync(join(env.rigwellHome, "settings.json"), "utf8")).toBe(before); expect(featureEnabled("script_subagents", true)).toBe(false);
    writeJson(join(env.root, ".rigwell/settings.json"), { features: { script_subagents: true } }); expect(featureEnabled("script_subagents", true)).toBe(false);
    const managed = join(env.root, "managed.json"); writeJson(managed, { features: { script_subagents: true } }); process.env.RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH = managed; expect(featureEnabled("script_subagents")).toBe(true); expect(parseFeatures(null)).toEqual({});
  } finally { if (prior === undefined) delete process.env.RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH; else process.env.RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH = prior; env.cleanup(); }
});

test("actual Script Task execution honors owner false over explicit init opt-in and enables only a new engine", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "Child fixture finished" }]), sessions: MemberSession[] = [];
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }], features: { script_subagents: false } });
    const open = async () => { const m = new MemberSession({ notify() {}, tools: (t) => t, request: async () => ({ selectedOption: "cancel" }) }); sessions.push(m); await m.call("initialize_session", { cwd: env.root, autonomyLevel: "high", allowSubagentsInScripts: true, toolExecutionMode: "script_only" }); return m.connection.session!; };
    const disabled = await open(), run = async (s: typeof disabled) => s.tools().find((t) => t.name === "Script")!.run({ script: 'const r = await tools.Task({description:"Fixture child",prompt:"Answer once"}); print(r);' }, { cwd: env.root, sessionId: s.id, readFiles: new Map(), signal: new AbortController().signal });
    expect((await run(disabled)).isError).toBe(true); expect(fake.requests).toHaveLength(0);
    updateUserSettings(env.rigwellHome, { features: { script_subagents: true } }); expect((await run(disabled)).isError).toBe(true); expect(fake.requests).toHaveLength(0);
    const enabled = await open(), result = await run(enabled); expect(result.isError).toBe(false); expect(result.content).toContain("Child fixture finished"); expect(fake.requests).toHaveLength(1); expect(fake.requests[0].tools.some((t: any) => t.name === "Task")).toBe(false);
  } finally { for (const session of sessions) await session.close(); fake.stop(); env.cleanup(); }
});

test("nested flags gate new stream settings and revoke new member controls without weakening policy or approved tool ceilings", async () => {
  const previous = process.env.RIGWELL_HOME, f = await setup();
  try {
    const home = process.env.RIGWELL_HOME!; expect(workstreamSettings(f.cwd).allowNestedSpawn).toBe(false); updateUserSettings(home, { features: { nested_workstreams: true } }); expect(workstreamSettings(f.cwd).allowNestedSpawn).toBe(true);
    f.store.update({ settings: { ...f.store.read().settings, allowNestedSpawn: true } });
    const parent = await f.service.spawn(f.lead.connection.session!, { name: "Parent", role: "task", prompt: "INITIAL", worktree: false, tools: ["Read", "Script", "SpawnAgent", "InterruptAgent"] }), session = f.service.members.get(parent.agentId)!.connection.session!; await session.idle(); expect(session.tools().some((t) => t.name === "SpawnAgent")).toBe(true);
    updateUserSettings(home, { features: { nested_workstreams: false } }); expect(session.tools().some((t) => t.name === "SpawnAgent")).toBe(false); const count = f.fake.requests.length;
    const error = await f.service.spawn(session, { name: "Blocked child", role: "task", prompt: "INITIAL", worktree: false }).then(() => null, (e) => e); expect(error.message).toContain("Only the lead"); expect(f.fake.requests).toHaveLength(count); expect(f.store.roster().some((a) => a.name === "Blocked child")).toBe(false);
    updateUserSettings(home, { features: { nested_workstreams: true } }); writeJson(join(home, "policy.json"), { schemaVersion: 1, workstreams: { allowNestedSpawn: false } }); expect(workstreamSettings(f.cwd).allowNestedSpawn).toBe(false);
    const policy = await f.service.spawn(session, { name: "Policy child", role: "task", prompt: "INITIAL", worktree: false }).then(() => null, (e) => e); expect(policy.message).toContain("policy"); expect(f.fake.requests).toHaveLength(count);
  } finally { await f.close(); if (previous === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = previous; }
});
