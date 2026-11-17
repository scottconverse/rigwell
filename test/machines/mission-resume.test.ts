import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpEnv } from "../storage/helpers.ts";
import { MissionRunner, DEFAULT_LIMITS, type MissionSettings } from "../../src/missions/runner.ts";
import { MissionStore } from "../../src/missions/store.ts";
import { WakeLock } from "../../src/missions/wakelock.ts";
import { zeroUsage } from "../../src/core/types.ts";
import type { WorkerRequest } from "../../src/missions/worker.ts";

for (const firstMachine of [undefined, "original-remote"]) test(`paused ${firstMachine ?? "local"} worker keeps its original host and cwd after defaults change`, async () => {
  const env = tmpEnv(), store = new MissionStore(join(env.root, "mission"));
  store.ensure();
  store.writeFeatures([{ id: "fixture", description: "Fixture", skillName: "fixture-worker", milestone: "one", status: "pending" }]);
  writeFileSync(store.path("validation-contract.md"), "Fixture contract");
  writeFileSync(store.path("validation-state.json"), "{}");
  mkdirSync(store.path("skills", "fixture-worker"), { recursive: true });
  writeFileSync(store.path("skills", "fixture-worker", "SKILL.md"), "---\nname: fixture-worker\ndescription: Fixture worker\n---\nPerform the fixture.\n");
  const originalCwd = join(env.root, "original-repo");
  store.writeState({ workingDirectory: originalCwd });
  let settings: MissionSettings = { ...(firstMachine ? { machine: firstMachine, workerWorkingDirectory: originalCwd } : {}) };
  const selected: WorkerRequest[] = [];
  const runner = new MissionRunner({ store, limits: DEFAULT_LIMITS, wake: new WakeLock(undefined),
    orchestrator: { sessionId: "fixture-lead", cwd: env.root, settings: () => settings, modelId: () => "fixture", reasoningEffort: () => "low", tokenUsage: zeroUsage },
    modelExists: () => true, workerUsage: zeroUsage, notify() {}, register() {}, unregister() {}, workerWrap: () => (tools) => tools,
    spawn(request) {
      selected.push(request);
      return { sessionId: request.sessionId, interrupt() {}, done: Promise.resolve({ status: "interrupted", interruptReason: "pause", text: "", messages: [], tokenUsage: zeroUsage() }) };
    },
  });
  try {
    expect((await runner.run({}, new AbortController().signal)).state).toBe("paused");
    const id = selected[0]!.sessionId;
    settings = { machine: "different-remote", workerWorkingDirectory: join(env.root, "different-repo") };
    store.writeState({ workingDirectory: join(env.root, "different-local-repo") });
    expect((await runner.run({}, new AbortController().signal)).state).toBe("paused");
    expect(selected.length).toBe(2);
    expect(selected[1]).toMatchObject({ sessionId: id, resume: true, cwd: originalCwd });
    if (firstMachine) expect(selected[1]!.machine).toBe(firstMachine);
    else expect(selected[1]!.machine).toBeUndefined();
    expect(store.readState()!.workerLocations?.[id]).toMatchObject({ cwd: originalCwd });
  } finally { env.cleanup(); }
});
