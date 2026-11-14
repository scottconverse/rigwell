import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "../../src/daemon/connection.ts";
import { createMissionService, checkMissionPath, lockCommand, WakeLock, checkReadiness } from "../../src/missions/index.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurnSpec } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const toolNames = (b: any): string[] => (b.tools ?? []).map((t: any) => t.name);
const assistantCount = (b: any) => (b.messages ?? []).filter((m: any) => m.role === "assistant").length;
const lastResult = (b: any): string => {
  const last = b.messages.at(-1);
  const r = (last?.content ?? []).filter((x: any) => x.type === "tool_result").at(-1);
  return typeof r?.content === "string" ? r.content : JSON.stringify(r?.content ?? "");
};
const firstText = (b: any): string => JSON.stringify(b.messages);

const handoff = (extra: Record<string, unknown> = {}) => ({
  salientSummary: "Did the work.", whatWasImplemented: "Implemented the feature fully.", whatWasLeftUndone: "",
  verification: { commandsRun: [{ command: "bun test", exitCode: 0, observation: "pass" }] },
  tests: { added: [], coverage: "n/a" }, discoveredIssues: [], ...extra,
});

interface Rig {
  home: string; repo: string; dir: string; sessionId: string; server: FakeServer;
  out: any[]; call(m: string, p: Record<string, unknown>): Promise<any>; turn(t: string): Promise<void>;
  notes(): any[]; conn: ReturnType<typeof createConnection>;
}

const SKILL = "---\nname: impl-worker\ndescription: Implements one feature\n---\nImplement the assigned feature, test it, then call EndFeatureRun with an honest handoff.\n";

function feature(id: string, extra: Record<string, unknown> = {}) {
  return { id, description: `Feature ${id}`, skillName: "impl-worker", milestone: "m1", status: "pending", preconditions: [], expectedBehavior: ["works"], fulfills: [], ...extra };
}

/** The orchestrator plans: propose, write plan files, then run; `after` decides what to do with each StartMissionRun result. */
function orchestratorTurn(rig: () => { dir: string }, features: unknown[], after: (result: any, n: number) => FakeTurnSpec) {
  let runs = 0;
  return (b: any): FakeTurnSpec => {
    const stage = assistantCount(b);
    const dir = rig().dir;
    if (stage === 0) return { toolCalls: [{ name: "ProposeMission", input: { title: "Test mission", proposal: "# Overview\nDo the thing." } }] };
    if (stage === 1) {
      const c = (p: string, content: string) => ({ name: "Create", input: { path: join(dir, p), content } });
      return { toolCalls: [
        c("features.json", JSON.stringify({ features })), c("validation-contract.md", "# Contract\nA1: it works\n"),
        c("validation-state.json", JSON.stringify({ assertions: { A1: { status: "pending" } } })), c("AGENTS.md", "Be careful.\n"),
        c("skills/impl-worker/SKILL.md", SKILL),
      ] };
    }
    if (stage === 2) return { toolCalls: [{ name: "StartMissionRun", input: {} }] };
    let r: any = {};
    try { r = JSON.parse(lastResult(b)); } catch { /* not json */ }
    return after(r, runs++);
  };
}

async function rig(script: (rig: Rig) => (b: any, i: number) => FakeTurnSpec, missionSettings: Record<string, unknown> = {}, svcOpts: Record<string, unknown> = {}, trace: (phase: string) => void = () => {}): Promise<Rig> {
  trace("fake model setup");
  const holder: { r?: Rig } = {};
  let built: ((b: any, i: number) => FakeTurnSpec) | undefined;
  const fn = (b: any, i: number) => (built ??= script(holder.r!))(b, i);
  const server = await startFakeAnthropic(Array.from({ length: 400 }, () => fn));
  servers.push(server);
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake" }]);
  process.env.RIGWELL_HOME = home;
  process.env.RIGWELL_NO_WAKE_LOCK = "1";
  trace("Git repository setup");
  const repo = makeRepo();
  trace("connection setup");
  const out: any[] = [];
  const svc = createMissionService({ lockSpawner: () => undefined, limits: { inactivityMs: 5000, startGraceMs: 2000, heartbeatMs: 60_000 }, retryBaseDelayMs: 1, ...svcOpts });
  let conn!: ReturnType<typeof createConnection>;
  const notify = (n: Record<string, unknown>) => conn.peer.notify("rigwell.session_notification", { sessionId: conn.session?.id, notification: n });
  const a = svc.attach({ session: () => conn.session, notify });
  conn = createConnection((line) => { for (const l of line.split("\n")) if (l.trim()) out.push(JSON.parse(l)); }, {
    canPrompt: false, retryBaseDelayMs: 1, wrapTools: a.wrapTools, extraMethods: a.methods,
  });
  let n = 0;
  const until = async (pred: () => any, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(5); }
  };
  const call = async (method: string, params: Record<string, unknown>) => {
    trace(`RPC ${method} sent`);
    const id = `m${++n}`;
    conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
    const r = await until(() => out.find((m) => m.type === "response" && m.id === id));
    trace(`RPC ${method} answered`);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  };
  const r = {
    home, repo, server, out, call, conn,
    notes: () => out.filter((m) => m.method === "rigwell.session_notification").map((m) => m.params.notification),
    async turn(text: string) {
      const before = out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length;
      await call("add_user_message", { text });
      await until(() => out.filter((m) => m.params?.notification?.type === "agent_turn_completed").length > before, 60_000);
    },
  } as Rig;
  holder.r = r;
  const init = await call("initialize_session", { machineId: "x", cwd: repo, interactionMode: "auto" });
  r.sessionId = init.sessionId;
  r.dir = join(home, "missions", init.sessionId);
  const entered = await call("enter_mission_mode", { continue: true });
  expect(entered.entered).toBe(true);
  await call("update_session_settings", { missionSettings });
  return r;
}

/** Worker model: on its first request call EndFeatureRun (via `act`), on later requests end the turn. */
function worker(b: any, act: (featureId: string, attempt: number) => FakeTurnSpec, state: { attempt: number }): FakeTurnSpec {
  const stage = assistantCount(b);
  if (stage === 0) state.attempt++;
  if (stage === 0) {
    const m = firstText(b).match(/Assigned feature: ([\w.-]+)/);
    return act(m![1], state.attempt);
  }
  return { text: "Finished." };
}

const endCall = (featureId: string, input: Record<string, unknown> = {}): FakeTurnSpec => ({
  toolCalls: [{ name: "EndFeatureRun", input: { successState: "success", returnToOrchestrator: false, featureId, validatorsPassed: true, handoff: handoff(), ...input } }],
});

describe("mission end to end (fake local model server)", () => {
  test("3 features, 1 milestone: both validators inserted and the mission completes", async () => {
    const wstate = { attempt: 0 };
    const order: string[] = [];
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1"), feature("f2"), feature("f3")], (res) => (res.state === "completed" ? { text: "Mission done." } : { text: `unexpected ${JSON.stringify(res).slice(0, 200)}` }));
      return (b) => (toolNames(b).includes("EndFeatureRun") ? worker(b, (id) => { order.push(id); return endCall(id); }, wstate) : orch(b));
    });
    await r.turn("Please plan and run a mission.");
    const features = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features;
    expect(order).toEqual(["f1", "f2", "f3", "scrutiny-validator-m1", "user-testing-validator-m1"]);
    expect(features.map((f: any) => f.id)).toEqual(["f1", "f2", "f3", "scrutiny-validator-m1", "user-testing-validator-m1"]); // completed move to the bottom, in order
    expect(features.every((f: any) => f.status === "completed")).toBe(true);
    const state = JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8"));
    expect(state.state).toBe("completed");
    expect(state.missionId).toMatch(/^mis_[0-9a-f]{8}$/);
    const log = readFileSync(join(r.dir, "progress_log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const types = log.map((e) => e.type);
    for (const t of ["mission_accepted", "mission_run_started", "worker_started", "worker_completed", "milestone_validation_triggered"]) expect(types).toContain(t);
    expect(log.filter((e) => e.type === "milestone_validation_triggered")).toHaveLength(1);
    expect(existsSync(join(r.dir, "worker-transcripts.jsonl"))).toBe(true);
    expect(readFileSync(join(r.dir, "handoffs.jsonl"), "utf8").trim().split("\n")).toHaveLength(5);
    const types2 = new Set(r.notes().map((n) => n.type));
    for (const t of ["mission_state_changed", "mission_features_changed", "mission_progress_entry", "mission_worker_started", "mission_worker_completed"]) expect(types2.has(t)).toBe(true);
    // The orchestrator's last turn reported the completed state.
    expect(JSON.parse(lastResult(r.server.requests.at(-1))).state).toBe("completed");
    // worker sessions are headless sessions with the mission tag
    const settingsFiles = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features[0].completedWorkerSessionId;
    expect(typeof settingsFiles).toBe("string");
  }, 90_000);

  test("skipScrutiny and skipUserTesting leave out the validators", async () => {
    const wstate = { attempt: 0 };
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1")], () => ({ text: "ok" }));
      return (b) => (toolNames(b).includes("EndFeatureRun") ? worker(b, (id) => endCall(id), wstate) : orch(b));
    }, { skipScrutiny: true, skipUserTesting: true });
    await r.turn("go");
    const ids = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features.map((f: any) => f.id);
    expect(ids).toEqual(["f1"]);
    expect(JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8")).state).toBe("completed");
  }, 60_000);

  test("the retry limit pauses the mission; resuming grants more attempts", async () => {
    const wstate = { attempt: 0 };
    const seen: string[] = [];
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1")], (res) => {
        seen.push(`${res.state}${res.pauseReason ? ":" + res.pauseReason : ""}`);
        return res.state === "completed" ? { text: "done" } : { toolCalls: [{ name: "StartMissionRun", input: {} }] };
      });
      // Workers exit without a handoff for the first 6 attempts, then succeed.
      return (b) => (toolNames(b).includes("EndFeatureRun") ? worker(b, (id, n) => (n <= 6 ? { text: "I give up." } : endCall(id)), wstate) : orch(b));
    }, { skipScrutiny: true, skipUserTesting: true });
    await r.turn("go");
    expect(seen).toEqual([
      "orchestrator_turn", "orchestrator_turn", "orchestrator_turn", "orchestrator_turn", "orchestrator_turn",
      "paused:feature_retry_limit_exceeded", "orchestrator_turn", "completed",
    ]);
    const st = JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8"));
    expect(st.featureRetryBudgetBonus.f1).toBe(5);
    const f = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features[0];
    expect(f.workerSessionIds).toHaveLength(7);
    const log = readFileSync(join(r.dir, "progress_log.jsonl"), "utf8");
    expect(log).toContain("mission_resumed");
    expect(log).toContain("exited_without_handoff");
  }, 120_000);

  test("a worker cannot write features.json, state.json or the log; reads of protected files are refused", async () => {
    const wstate = { attempt: 0 };
    const results: string[] = [];
    let step = 0;
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1")], () => ({ text: "ok" }));
      return (b) => {
        if (!toolNames(b).includes("EndFeatureRun")) return orch(b);
        const stage = assistantCount(b);
        if (stage > 0) results.push(lastResult(b));
        const m = firstText(b).match(/Assigned feature: ([\w.-]+)/)![1];
        const dir = r.dir;
        const tries: FakeTurnSpec[] = [
          { toolCalls: [{ name: "Create", input: { path: join(dir, "features.json"), content: '{"features":[]}' } }] },
          { toolCalls: [{ name: "Edit", input: { path: join(dir, "features.json"), old_text: "f1", new_text: "zz" } }] },
          { toolCalls: [{ name: "Read", input: { path: join(dir, "state.json") } }] },
          { toolCalls: [{ name: "Create", input: { path: join(dir, "progress_log.jsonl"), content: "x" } }] },
          { toolCalls: [{ name: "Execute", input: { command: `cat ${join(dir, "state.json")}`, riskLevel: "low", riskReason: "read" } }] },
        ];
        if (step < tries.length) return tries[step++];
        wstate.attempt++;
        return stage === tries.length ? endCall(m) : { text: "done" };
      };
    }, { skipScrutiny: true, skipUserTesting: true });
    await r.turn("go");
    const protectedResults = results.slice(0, 5);
    expect(protectedResults.every((x) => /Refused/.test(x))).toBe(true);
    expect(results[0]).toContain("Workers report only through EndFeatureRun");
    const features = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features;
    expect(features).toHaveLength(1);
    expect(features[0].id).toBe("f1");
    expect(readFileSync(join(r.dir, "progress_log.jsonl"), "utf8")).not.toBe("x");
    expect(JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8")).state).toBe("completed");
  }, 60_000);

  test("an invalid features.json write by the orchestrator is refused and rolled back", async () => {
    let seenErr = "";
    const r = await rig((r) => (b) => {
      const stage = assistantCount(b);
      if (stage === 0) return { toolCalls: [{ name: "ProposeMission", input: { title: "T", proposal: "P" } }] };
      if (stage === 1) return { toolCalls: [{ name: "Create", input: { path: join(r.dir, "features.json"), content: '{"features":[{"id":"x"}]}' } }] };
      seenErr = lastResult(b);
      return { text: "ok" };
    });
    await r.turn("go");
    expect(seenErr).toContain("features.json is invalid");
    expect(seenErr).toContain("Example of the right shape");
    expect(existsSync(join(r.dir, "features.json"))).toBe(false);
  }, 30_000);

  test("the handoff gate refuses a run until items are dismissed", async () => {
    const wstate = { attempt: 0 };
    const results: any[] = [];
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1"), feature("f2")], (res, n) => {
        results.push(res);
        if (n === 0) return { toolCalls: [{ name: "StartMissionRun", input: {} }] }; // refused by the gate
        if (n === 1) return { toolCalls: [{ name: "DismissHandoffItems", input: { dismissals: [{ type: "discovered_issue", justification: "Not relevant to this mission, noted only." }] } }] };
        if (n === 2) return { toolCalls: [{ name: "StartMissionRun", input: {} }] };
        return { text: "end" };
      });
      return (b) => (toolNames(b).includes("EndFeatureRun")
        ? worker(b, (id) => endCall(id, { handoff: handoff({ discoveredIssues: [{ severity: "non_blocking", description: "a nit" }] }) }), wstate)
        : orch(b));
    }, { skipScrutiny: true, skipUserTesting: true });
    await r.turn("go");
    expect(results[0].state).toBe("orchestrator_turn"); // first run: f1 handed off with an issue
    expect(results[1].started).toBe(false); // gate
    expect(results[1].message).toContain("DismissHandoffItems");
    expect(results.length).toBeGreaterThanOrEqual(4);
    const log = readFileSync(join(r.dir, "progress_log.jsonl"), "utf8");
    expect(log).toContain("handoff_items_dismissed");
  }, 60_000);

  test("a silent worker is failed by the watchdog and the feature is requeued", async () => {
    const r = await rig((r) => {
      const orch = orchestratorTurn(() => r, [feature("f1")], () => ({ text: "ok" }));
      return (b) => (toolNames(b).includes("EndFeatureRun") ? { hang: true } : orch(b));
    }, { skipScrutiny: true, skipUserTesting: true }, { limits: { inactivityMs: 150, startGraceMs: 100, heartbeatMs: 60_000 } });
    await r.turn("go");
    const log = readFileSync(join(r.dir, "progress_log.jsonl"), "utf8");
    expect(log).toContain("inactivity_timeout");
    const f = JSON.parse(readFileSync(join(r.dir, "features.json"), "utf8")).features[0];
    expect(f.status).toBe("pending");
    expect(JSON.parse(readFileSync(join(r.dir, "state.json"), "utf8")).state).toBe("orchestrator_turn");
  }, 30_000);
});

function lastTextOf(server: FakeServer): string {
  return JSON.stringify(server.requests.at(-1)?.messages ?? "");
}

describe("crash recovery and mission tools gating", () => {
  test("a stale running state becomes paused when the session is first seen; tools exist only in mission mode", async () => {
    const started = performance.now(), events: { phase: string; elapsedMs: number }[] = [];
    const trace = (phase: string) => { events.push({ phase, elapsedMs: Math.round(performance.now() - started) }); };
    const diagnostics = () => console.error("Mission recovery diagnostics", JSON.stringify({ elapsedMs: Math.round(performance.now() - started), events }));
    const timer = setTimeout(diagnostics, 4000); timer.unref();
    let r: Rig | undefined;
    try {
      r = await rig(() => () => ({ text: "hi" }), {}, {}, trace);
      trace("write stale mission state");
      mkdirSync(r.dir, { recursive: true });
      writeFileSync(join(r.dir, "state.json"), JSON.stringify({ missionId: "mis_00000000", state: "running", workingDirectory: r.repo, createdAt: "x", updatedAt: "x", lastReviewedHandoffCount: 0, initialFeatureCount: 0, featureRetryBudgetBonus: {} }));
      const got = await r.call("mission_get", {});
      expect(got.state).toBe("paused");
      expect(got.pauseReason).toBe("crash_recovery");
      const tools = (await r.call("list_tools", {})).tools.map((t: any) => t.id);
      expect(tools).toContain("ProposeMission");
      expect(tools).not.toContain("EndFeatureRun");
      await r.call("update_session_settings", { interactionMode: "auto" });
      expect((await r.call("list_tools", {})).tools.map((t: any) => t.id)).not.toContain("ProposeMission");
    } finally {
      clearTimeout(timer);
      if (performance.now() - started >= 4000) diagnostics();
      await r?.conn.shutdown();
    }
  });
});

describe("file protection", () => {
  test("symlinks to protected files are refused; unresolvable symlinks are refused", () => {
    const home = makeHome([]);
    process.env.RIGWELL_HOME = home;
    const dir = join(home, "missions", "sess1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{}");
    writeFileSync(join(dir, "features.json"), "{}");
    const link = join(home, "innocent.txt");
    if (process.platform === "win32") symlinkSync(dir, link, "junction");
    else symlinkSync(join(dir, "state.json"), link);
    expect(checkMissionPath(process.platform === "win32" ? join(link, "state.json") : link, home, "orchestrator", "read")).toContain("Refused");
    expect(checkMissionPath(join(dir, "state.json"), home, "other", "write")).toContain("Refused");
    expect(checkMissionPath(join(dir, "features.json"), home, "worker", "write")).toContain("Refused");
    expect(checkMissionPath(join(dir, "features.json"), home, "worker", "read")).toBeNull();
    expect(checkMissionPath(join(dir, "features.json"), home, "orchestrator", "write")).toBeNull();
    symlinkSync(join(home, "nowhere", "x"), join(home, "dangling"), process.platform === "win32" ? "junction" : "file");
    expect(checkMissionPath(join(home, "dangling"), home, "orchestrator", "read")).toContain("cannot be resolved");
    expect(checkMissionPath(join(home, "plain.txt"), home, "worker", "write")).toBeNull();
  });
});

describe("wake lock and readiness", () => {
  test("ref-counted lock: one process for many missions, terminate then kill", async () => {
    const calls: string[] = [];
    let spawned = 0;
    const lock = new WakeLock(() => { spawned++; return { kill: (s) => void calls.push(s ?? "SIGTERM"), exited: new Promise(() => {}) }; }, 20);
    lock.acquire(); lock.acquire();
    expect(spawned).toBe(1);
    lock.release();
    expect(lock.held).toBe(true);
    lock.release();
    expect(lock.held).toBe(false);
    expect(calls).toEqual(["SIGTERM"]);
    await Bun.sleep(40);
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("platform commands", () => {
    expect(lockCommand("darwin", 7, () => null)).toEqual(["caffeinate", "-i", "-w", "7"]);
    expect(lockCommand("linux", 7, (n) => (n === "systemd-inhibit" ? "/x" : null))![0]).toBe("systemd-inhibit");
    expect(lockCommand("linux", 7, (n) => (n === "gnome-session-inhibit" ? "/x" : null))![0]).toBe("gnome-session-inhibit");
    expect(lockCommand("linux", 7, () => null)).toBeUndefined();
    expect(lockCommand("win32", 7, () => null)![0]).toBe("powershell");
  });
  test("readiness results", () => {
    process.env.RIGWELL_HOME = makeHome([]);
    const repo = makeRepo();
    expect(checkReadiness(repo, (a) => (a[0] === "rev-parse" && a[1] === "--is-inside-work-tree" ? "false" : null)).status).toBe("no_git");
    const git = (a: string[]) => (a[0] === "remote" ? null : a[1] === "--is-inside-work-tree" ? "true" : repo);
    expect(checkReadiness(repo, git).status).toBe("no_remote");
    const withRemote = (a: string[]) => (a[0] === "remote" ? "git@example.com:x/y.git" : a[1] === "--is-inside-work-tree" ? "true" : repo);
    expect(checkReadiness(repo, withRemote).status).toBe("no_report");
    mkdirSync(join(repo, ".rigwell"), { recursive: true });
    writeFileSync(join(repo, ".rigwell", "readiness-report.json"), JSON.stringify({ repoUrl: "git@example.com:x/y.git", level: 2 }));
    expect(checkReadiness(repo, withRemote).status).toBe("low_score");
    writeFileSync(join(repo, ".rigwell", "readiness-report.json"), JSON.stringify({ repoUrl: "git@example.com:x/y.git", level: 4 }));
    expect(checkReadiness(repo, withRemote).status).toBe("ok");
    const empty = require("node:fs").mkdtempSync(join(require("node:os").tmpdir(), "rw-empty-"));
    expect(checkReadiness(empty).status).toBe("ok");
  });
});
