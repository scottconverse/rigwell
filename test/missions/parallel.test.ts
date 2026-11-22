import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpEnv } from "../storage/helpers.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { zeroUsage } from "../../src/core/types.ts";
import { areasOverlap, clampWorkers, pickRunnable } from "../../src/missions/parallel.ts";
import { DEFAULT_LIMITS, MissionRunner, type MissionSettings, type RunHandle } from "../../src/missions/runner.ts";
import { MissionStore, type Feature } from "../../src/missions/store.ts";
import { workerTools } from "../../src/missions/tools.ts";
import { WakeLock } from "../../src/missions/wakelock.ts";
import type { WorkerOutcome, WorkerRequest } from "../../src/missions/worker.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";

const feature = (id: string, extra: Partial<Feature> = {}): Feature => ({ id, description: `Feature ${id}`, skillName: "impl-worker", milestone: "m1", status: "pending", ...extra } as Feature);
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
const handoff = { salientSummary: "Did the work.", whatWasImplemented: "Implemented the feature fully.", whatWasLeftUndone: "", verification: { commandsRun: [{ command: "bun test", exitCode: 0, observation: "pass" }] }, tests: { added: [], coverage: "n/a" }, discoveredIssues: [] };
const outcome = (status: WorkerOutcome["status"], extra: Partial<WorkerOutcome> = {}): WorkerOutcome => ({ status, text: "", messages: [], tokenUsage: zeroUsage(), ...extra });

type Job = { req: WorkerRequest; id: string; write(file: string, text: string): void; finish(): Promise<WorkerOutcome>; interrupted: Promise<string> };

function setup(features: Feature[], settings: MissionSettings, act: (j: Job) => Promise<WorkerOutcome>) {
  const env = tmpEnv(), repo = makeRepo(), store = new MissionStore(join(env.root, "mission"));
  store.ensure();
  store.writeFeatures(features);
  writeFileSync(store.path("validation-contract.md"), "Contract");
  writeFileSync(store.path("validation-state.json"), "{}");
  mkdirSync(store.path("skills", "impl-worker"), { recursive: true });
  writeFileSync(store.path("skills", "impl-worker", "SKILL.md"), "---\nname: impl-worker\ndescription: Worker\n---\nWork.\n");
  store.writeState({ workingDirectory: repo });
  const requests: WorkerRequest[] = [];
  const live = { now: 0, peak: 0 };
  const manager = new WorktreeManager({ root: join(env.root, "worktrees") });
  let handle: RunHandle | undefined;
  const runner = new MissionRunner({
    store, limits: DEFAULT_LIMITS, wake: new WakeLock(undefined),
    orchestrator: { sessionId: "lead", cwd: repo, settings: () => settings, modelId: () => "fixture", reasoningEffort: () => "low", tokenUsage: zeroUsage },
    modelExists: () => true, workerUsage: zeroUsage, notify() {}, register(h: RunHandle) { handle = h; }, unregister() {}, workerWrap: () => (t) => t, worktrees: () => manager,
    spawn(req) {
      requests.push(req);
      let stop!: (r: string) => void;
      const interrupted = new Promise<string>((r) => { stop = r; });
      const id = store.features().find((f) => f.currentWorkerSessionId === req.sessionId)!.id;
      const job: Job = {
        req, id, interrupted,
        write(file, text) { writeFileSync(join(req.cwd, file), text); git(req.cwd, "add", "."); git(req.cwd, "commit", "-qm", `work ${id}`); },
        async finish() {
          const r = await workerTools({ sessionId: req.sessionId, store, workingDirectory: () => req.cwd })[0]!.run({ successState: "success", returnToOrchestrator: false, featureId: id, validatorsPassed: true, handoff }, { sessionId: req.sessionId } as never);
          if (r.isError) throw new Error(r.content as string);
          return outcome("ended");
        },
      };
      live.peak = Math.max(live.peak, ++live.now);
      const done = (async () => { await Bun.sleep(5); return await act(job); })().catch((e) => outcome("error", { errorMessage: (e as Error).message })).finally(() => { live.now--; });
      return { sessionId: req.sessionId, interrupt: (r: string) => stop(r), done };
    },
  });
  const cleanup = () => { env.cleanup(); rmSync(repo, { recursive: true, force: true, maxRetries: 5 }); };
  return { store, repo, runner, requests, live, cleanup, handle: () => handle!, run: (input = {}) => runner.run(input, new AbortController().signal) };
}

const skip = { skipScrutiny: true, skipUserTesting: true };
const two = () => [feature("a", { fileAreas: ["src/a"] }), feature("b", { fileAreas: ["src/b"] })];

describe("which features may run together", () => {
  test("the limit stays between 1 and 4", () => {
    expect([undefined, 0, 1, 3, 9, 2.5].map(clampWorkers)).toEqual([1, 1, 1, 3, 4, 1]);
  });
  test("areas overlap on a parent folder, on case, and on a wildcard", () => {
    expect(areasOverlap(["src/a"], ["src/a/x.ts"])).toBe(true);
    expect(areasOverlap(["SRC\\A"], ["src/a"])).toBe(true);
    expect(areasOverlap(["src/*"], ["src/a"])).toBe(true);
    expect(areasOverlap(["src/a"], ["src/b"])).toBe(false);
  });
  test("dependencies, missing areas and overlaps keep features apart", () => {
    const ids = (f: Feature[], running: string[] = []) => pickRunnable(f, new Set(running), 4).map((x) => x.id);
    expect(ids(two())).toEqual(["a", "b"]);
    expect(ids([feature("a", { fileAreas: ["x"] }), feature("b", { fileAreas: ["y"], dependsOn: ["a"] })])).toEqual(["a"]);
    expect(ids([feature("a", { fileAreas: ["x"] }), feature("b", { fileAreas: ["x/y"] })])).toEqual(["a"]);
    expect(ids([feature("a"), feature("b", { fileAreas: ["y"] })])).toEqual(["a"]);
    expect(ids([feature("a", { fileAreas: ["x"], status: "in_progress" }), feature("b")], ["a"])).toEqual([]);
  });
});

describe("parallel mission run (real git, fake workers)", () => {
  test("limit 1 works in the user's folder, with no mission branch", async () => {
    const t = setup(two(), { ...skip }, async (j) => { j.write(`${j.id}.txt`, j.id); return await j.finish(); });
    try {
      expect((await t.run()).state).toBe("completed");
      expect(t.live.peak).toBe(1);
      expect(t.requests.every((r) => r.cwd === t.repo)).toBe(true);
      expect(t.store.readState()!.missionBranch).toBeUndefined();
      expect(existsSync(join(t.repo, "a.txt"))).toBe(true);
    } finally { t.cleanup(); }
  }, 30000);

  test("two independent features run at once and merge to the mission branch only", async () => {
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    let started = 0;
    const t = setup(two(), { ...skip, maxParallelWorkers: 2 }, async (j) => {
      if (++started === 2) release();
      await both;
      j.write(`${j.id}.txt`, j.id);
      return await j.finish();
    });
    try {
      const head = git(t.repo, "rev-parse", "HEAD");
      const r = await t.run();
      expect(r.state).toBe("completed");
      expect(t.live.peak).toBe(2);
      const branch = t.store.readState()!.missionBranch!;
      expect(r.message).toContain(branch);
      expect(git(t.repo, "rev-parse", "HEAD")).toBe(head);
      expect(existsSync(join(t.repo, "a.txt"))).toBe(false);
      expect(git(t.repo, "ls-tree", "--name-only", branch).split("\n")).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
      expect(t.store.features().every((f) => f.mergeStatus === "merged")).toBe(true);
    } finally { t.cleanup(); }
  }, 30000);

  test("validators run alone, on the merged code", async () => {
    const seen: Record<string, boolean> = {};
    const t = setup(two(), { skipUserTesting: true, maxParallelWorkers: 2 }, async (j) => {
      if (j.id.startsWith("scrutiny")) seen.merged = existsSync(join(j.req.cwd, "a.txt")) && existsSync(join(j.req.cwd, "b.txt"));
      else j.write(`${j.id}.txt`, j.id);
      return await j.finish();
    });
    try {
      expect((await t.run()).state).toBe("completed");
      expect(seen.merged).toBe(true);
    } finally { t.cleanup(); }
  }, 30000);

  test("a merge conflict stops that feature, keeps its branch and is not resolved", async () => {
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    let started = 0;
    const t = setup(two(), { ...skip, maxParallelWorkers: 2 }, async (j) => {
      if (++started === 2) release();
      await both;
      j.write("greet.js", `changed by ${j.id}\n`);
      return await j.finish();
    });
    try {
      const r = await t.run();
      expect(r.state).not.toBe("completed");
      expect(r.message).toContain("greet.js");
      const lost = t.store.features().find((f) => f.mergeStatus === "conflict")!;
      expect(lost.status).toBe("pending");
      expect(git(t.repo, "branch", "--list", lost.workBranch!)).toContain(lost.workBranch!);
      const st = t.store.readState()!;
      expect(() => git(st.integrationPath!, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
      expect(git(st.integrationPath!, "status", "--porcelain")).toBe("");
    } finally { t.cleanup(); }
  }, 30000);

  test("killing one of two lets the other finish and starts no new worker", async () => {
    const features = [...two(), feature("c", { fileAreas: ["src/c"] })];
    let release!: () => void;
    const killed = new Promise<void>((r) => { release = r; });
    const t = setup(features, { ...skip, maxParallelWorkers: 2 }, async (j) => {
      if (j.id === "a") { const why = await j.interrupted; release(); return outcome("interrupted", { interruptReason: why }); }
      await killed;
      j.write("b.txt", "b");
      return await j.finish();
    });
    try {
      const run = t.run();
      for (let i = 0; i < 400 && t.requests.length < 2; i++) await Bun.sleep(5);
      await Bun.sleep(20);
      expect(t.handle().killWorker(t.requests.find((r) => t.store.features().find((f) => f.id === "a")?.currentWorkerSessionId === r.sessionId)!.sessionId)).toBe(true);
      const r = await run;
      expect(r.state).not.toBe("completed");
      const byId = Object.fromEntries(t.store.features().map((f) => [f.id, f]));
      expect(byId.a!.status).toBe("pending");
      expect(byId.b!.mergeStatus).toBe("merged");
      expect(byId.c!.status).toBe("pending");
      expect(t.requests.length).toBe(2);
    } finally { t.cleanup(); }
  }, 30000);

  test("after a stop, every in-progress worker resumes in its own folder", async () => {
    let round = 1;
    const t = setup(two(), { ...skip, maxParallelWorkers: 2 }, async (j) => {
      if (round === 1) return outcome("interrupted", { interruptReason: "pause" });
      j.write(`${j.id}.txt`, j.id);
      return await j.finish();
    });
    try {
      for (let i = 0; i < 3 && t.store.features().filter((f) => f.status === "in_progress").length < 2; i++) await t.run();
      const first = new Map(t.requests.map((r) => [r.sessionId, r.cwd]));
      expect(t.store.features().filter((f) => f.status === "in_progress").length).toBe(2);
      round = 2;
      const before = t.requests.length;
      expect((await t.run()).state).toBe("completed");
      const resumed = t.requests.slice(before);
      expect(resumed.length).toBe(2);
      for (const q of resumed) { expect(q.resume).toBe(true); expect(q.cwd).toBe(first.get(q.sessionId)!); }
      expect(t.store.features().every((f) => f.mergeStatus === "merged")).toBe(true);
    } finally { t.cleanup(); }
  }, 30000);

  test("a spend-limit stop on one worker lets the other finish and starts no new worker", async () => {
    const features = [...two(), feature("c", { fileAreas: ["src/c"] })];
    let release!: () => void;
    const stopped = new Promise<void>((r) => { release = r; });
    const t = setup(features, { ...skip, maxParallelWorkers: 2 }, async (j) => {
      if (j.id === "a") { setTimeout(release, 20); return outcome("error", { errorMessage: "Spend limit reached" }); }
      await stopped;
      await Bun.sleep(40);
      j.write("b.txt", "b");
      return await j.finish();
    });
    try {
      const r = await t.run();
      expect(r.state).not.toBe("completed");
      const byId = Object.fromEntries(t.store.features().map((f) => [f.id, f]));
      expect(byId.b!.mergeStatus).toBe("merged");
      expect(byId.c!.status).toBe("pending");
      expect(t.requests.length).toBe(2);
    } finally { t.cleanup(); }
  }, 30000);

  test("a worker cannot report success with uncommitted work", async () => {
    const t = setup(two(), { ...skip, maxParallelWorkers: 2 }, async (j) => {
      writeFileSync(join(j.req.cwd, `${j.id}.txt`), "not committed");
      return await j.finish();
    });
    try {
      const r = await t.run();
      expect(r.state).not.toBe("completed");
      expect(r.message).toContain("crashed");
      expect(t.store.features().every((f) => f.status === "pending")).toBe(true);
    } finally { t.cleanup(); }
  }, 30000);
});
