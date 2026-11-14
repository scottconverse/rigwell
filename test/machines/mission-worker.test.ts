import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { MissionStore } from "../../src/missions/store.ts";
import { workerTools } from "../../src/missions/tools.ts";
import { spawnWorkerSession } from "../../src/missions/worker.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import { RemoteSessionStore } from "../../src/machines/sessions.ts";

test("remote mission worker protects its plan, verifies the remote commit and records its local handoff", async () => {
  const env = tmpEnv(), remoteHome = join(env.root, "remote-state"), cwd = join(env.root, "remote-repo"), id = crypto.randomUUID();
  mkdirSync(cwd);
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git(["init", "-q"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  writeFileSync(join(cwd, "fixture.txt"), "fixture"); git(["add", "."]); git(["commit", "-qm", "Fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  const dir = join(remoteHome, "missions", id);
  const handoff = { salientSummary: "Remote fixture verified.", whatWasImplemented: "Verified the isolated remote repository.", whatWasLeftUndone: "", verification: { commandsRun: [{ command: "git status", exitCode: 0, observation: "fixture" }] }, tests: { added: [], coverage: "fixture acceptance" }, discoveredIssues: [] };
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Create", input: { path: join(dir, "features.json"), content: "{}" } }] },
    { toolCalls: [{ name: "Create", input: { path: join(dir, "library", "learning.md"), content: "Remote worker learned this fixture.\n" } }] },
    { toolCalls: [{ name: "EndFeatureRun", input: { successState: "success", validatorsPassed: true, returnToOrchestrator: false, commitId: commit, repoPath: cwd, handoff } }] },
    { text: "Remote worker finished." },
  ]);
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), script = join(env.root, "fake-ssh-worker.ts");
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  const store = new MissionStore(join(env.root, "local-mission")); store.ensure();
  store.writeState({ workingDirectory: join(env.root, "different-local-repo") });
  const feature = { id: "fixture", description: "Verify remote", milestone: "one", skillName: "fixture-worker", status: "in_progress" as const, currentWorkerSessionId: id, workerSessionIds: [id] };
  store.writeFeatures([feature]);
  writeFileSync(store.path("mission.md"), "Approved fixture"); writeFileSync(store.path("AGENTS.md"), "Verify only the fixture.");
  mkdirSync(store.path("skills", "fixture-worker")); writeFileSync(store.path("skills", "fixture-worker", "SKILL.md"), "Fixture skill");
  let client: RpcClient | undefined;
  try {
    const h = spawnWorkerSession({ sessionId: id, resume: false, machine: "fixture", cwd, modelId: "custom:Remote-fixture-0", missionId: "fixture", role: "worker", missionDir: store.dir, feature, prompt: "unused local paths", inactivityMs: 2000, startGraceMs: 1000,
      wrapTools: (_tools, services) => workerTools({ sessionId: id, store, workingDirectory: () => store.readState()!.workingDirectory, ...services }),
      connectMachine: async () => client = new RpcClient(new SshTransport({ name: "fixture", host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })),
    });
    const result = await h.done;
    expect(result.errorMessage).toBeUndefined(); expect(result.status).toBe("ended");
    expect(result.text).toContain("Remote worker finished"); expect(result.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(store.features()[0].status).toBe("completed"); expect(store.handoffFor(id)?.commitId).toBe(commit);
    expect(readFileSync(store.path("library", "learning.md"), "utf8")).toBe("Remote worker learned this fixture.\n");
    expect(JSON.parse(readFileSync(join(dir, "features.json"), "utf8")).features[0].status).toBe("in_progress");
    expect(JSON.stringify(fake.requests[1].messages)).toContain("features.json belongs to the orchestrator");
    expect(JSON.stringify(fake.requests[0].messages)).not.toContain("unused local paths");
    expect(client?.isClosed).toBe(true);
    expect(new RemoteSessionStore().get(id)?.tokenUsage).toEqual(result.tokenUsage);
  } finally { await client?.close(); fake.stop(); env.cleanup(); }
}, 5000);

test("interrupt during SSH startup returns and closes a late connection without starting a worker", async () => {
  let opened!: (c: RpcClient) => void, closed = false;
  const opening = new Promise<RpcClient>((r) => { opened = r; });
  const h = spawnWorkerSession({ sessionId: crypto.randomUUID(), resume: false, machine: "fixture", cwd: ".", modelId: "fake", missionId: "fixture", role: "worker", missionDir: ".", feature: { id: "fixture", description: "Fixture", skillName: "fixture", milestone: "one", status: "pending" }, prompt: "", wrapTools: () => [], inactivityMs: 1000, startGraceMs: 1000, connectMachine: () => opening });
  h.interrupt("user");
  expect((await h.done).status).toBe("interrupted");
  opened(new RpcClient({ onMessage: () => {}, onClose: () => {}, write() { throw new Error("Startup must not send requests after interruption"); }, async close() { closed = true; } }));
  // Drain the late connection's resolution and asynchronous close.
  await opening; await new Promise((r) => setTimeout(r, 0));
  expect(closed).toBe(true);
});

test("worker watchdog closes an owned channel that stalls while returning mission notes", async () => {
  const env = tmpEnv(), id = crypto.randomUUID(), calls: string[] = [];
  let closed = false;
  const wire: import("../../src/sdk/transport.ts").Transport = { onMessage() {}, onClose() {},
    write(line) {
      const message = JSON.parse(line), method = message.method.replace(/^rigwell\./, ""); calls.push(method);
      if (method === "mission_worker_library_snapshot") return;
      const result = method === "prepare_mission_worker" ? { dir: env.root, cwd: env.root, prompt: "fixture" } : {};
      queueMicrotask(() => {
        wire.onMessage(JSON.stringify({ jsonrpc: "2.0", type: "response", id: message.id, result }));
        if (method === "add_user_message") wire.onMessage(JSON.stringify({ jsonrpc: "2.0", type: "notification", method: "rigwell.session_notification", params: { notification: { type: "agent_turn_completed", reason: "completed" } } }));
      });
    }, async close() { closed = true; wire.onClose(); },
  };
  const client = new RpcClient(wire), missionDir = join(env.root, "mission"); mkdirSync(missionDir);
  writeFileSync(join(missionDir, "mission.md"), "Fixture");
  const handle = spawnWorkerSession({ sessionId: id, resume: false, machine: "fixture", cwd: env.root, modelId: "fake", missionId: "fixture", role: "worker", missionDir,
    feature: { id: "fixture", description: "Fixture", skillName: "fixture", milestone: "one", status: "pending" }, prompt: "", inactivityMs: 20, startGraceMs: 1000,
    wrapTools: () => [{ name: "EndFeatureRun", description: "fixture", inputSchema: { type: "object" }, category: "other", async run() { return { content: "done" }; } }], connectMachine: async () => client,
  });
  let watchdogCheck: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([handle.done, new Promise<null>((resolve) => { watchdogCheck = setTimeout(() => resolve(null), 500); })]);
    expect(outcome?.status).toBe("timeout"); expect(closed).toBe(true);
    expect(calls).toContain("close_session");
  } finally { clearTimeout(watchdogCheck); await client.close(); await handle.done; env.cleanup(); }
});
