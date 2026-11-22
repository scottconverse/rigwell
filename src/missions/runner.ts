// The mission runner (spec §15.1 step 5-7, §15.6, §15.7): works through features.json one worker at a time.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage, Tool } from "../core/types.ts";
import { zeroUsage } from "../core/types.ts";
import { stepFrom } from "../agent/step.ts";
import { parseSkillFile } from "../skills/skills.ts";
import { dependencyProblem, isValidatorSkill, needsAttention, type Feature, type HandoffRecord, type MissionState, type MissionStore } from "./store.ts";
import { MissionWorkspace, clampWorkers, isRemoteMachine, pickRunnable } from "./parallel.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { skeleton, type WorkerOutcome, type WorkerSpawner } from "./worker.ts";
import type { WakeLock } from "./wakelock.ts";
import { effectivePolicy } from "../storage/policy.ts";

export interface MissionSettings {
  machine?: string;
  workerWorkingDirectory?: string;
  workerModel?: string;
  workerReasoningEffort?: string;
  validationWorkerModel?: string;
  validationWorkerReasoningEffort?: string;
  skipScrutiny?: boolean;
  skipUserTesting?: boolean;
  /** How many workers may run at once (1 to 4). The default is 1. */
  maxParallelWorkers?: number;
}

export interface Limits {
  inactivityMs: number;
  startGraceMs: number;
  heartbeatMs: number;
  retryLimit: number;
  scopeGrowthMultiplier: number;
  scopeGrowthMinAdded: number;
}

export const DEFAULT_LIMITS: Limits = {
  inactivityMs: Number(process.env.RIGWELL_MISSION_WORKER_INACTIVITY_TIMEOUT_MS) || 600_000,
  startGraceMs: 300_000, heartbeatMs: 180_000, retryLimit: 5, scopeGrowthMultiplier: 4, scopeGrowthMinAdded: 25,
};

export interface OrchestratorInfo {
  sessionId: string;
  cwd: string;
  modelId(): string;
  reasoningEffort(): string | undefined;
  settings(): MissionSettings;
  tokenUsage(): TokenUsage;
}

export interface RunnerDeps {
  store: MissionStore;
  orchestrator: OrchestratorInfo;
  spawn: WorkerSpawner;
  modelExists(id: string): boolean;
  /** Tool-list rewrite for a worker connection (EndFeatureRun and file protection). */
  workerWrap(workerSessionId: string): import("./worker.ts").WorkerRequest["wrapTools"];
  notify(n: Record<string, unknown>): void;
  wake: WakeLock;
  limits: Limits;
  retryBaseDelayMs?: number;
  log?: (m: string) => void;
  /** Token totals of finished workers, read from local session records. */
  workerUsage(workerSessionIds: string[]): TokenUsage;
  /** Called on every progress snapshot (tool status updates). */
  onProgress?(snapshot: Record<string, unknown>): void;
  /** Registered while a run is live. */
  register(h: RunHandle): void;
  unregister(h: RunHandle): void;
  /** Worktree manager for parallel runs. */
  worktrees(): WorktreeManager;
}

export interface RunHandle {
  sessionId: string;
  pause(reason: string): void;
  killWorker(workerSessionId: string): boolean;
  currentWorkerId(): string | undefined;
}

export interface RunInput {
  message?: string;
  resumeWorkerSessionId?: string;
  restartFeature?: boolean;
  messageToWorker?: string;
}

export interface RunResult {
  ok: boolean;
  /** Present when ok is false: why the run was refused. */
  refusal?: string;
  state: MissionState;
  pauseReason?: string;
  message: string;
  handoffs: HandoffRecord[];
  latestHandoff?: HandoffRecord;
  counts: Record<string, number>;
  progress: Record<string, unknown>;
  tokenUsage: TokenUsage;
}

const BILLING = /HTTP 402|billing|quota|insufficient[_ ]funds|credit balance|payment required/i;

const doneStatus = (f: Feature) => f.status === "completed" || f.status === "cancelled";
const attemptsOf = (f: Feature) => f.workerSessionIds?.length ?? 0;

export class MissionRunner {
  private workers = new Map<string, { id: string; interrupt(reason: string): void; featureId: string; description: string; startedAt: number; step?: string }>();
  private pauseRequest?: string;
  private startedAt = Date.now();
  private lastBilling = false;

  constructor(private d: RunnerDeps) {}

  private get store() { return this.d.store; }

  // ---------- gates (spec §15.7) ----------

  /** Returns a refusal message, or null when the run may start. */
  runGates(): string | null {
    const s = this.store;
    const policy = effectivePolicy().missions;
    if (policy?.enabled === false || policy?.maxConcurrentRuns === 0) return "Missions are disabled by policy.";
    if (!s.exists()) return "No mission folder exists yet: call ProposeMission first.";
    const features = s.features();
    if (policy?.maxFeatures !== undefined && features.filter((f) => f.status !== "cancelled").length > policy.maxFeatures) return "Mission feature count exceeds policy maxFeatures.";
    if (!features.length) return "features.json has no features. Write the plan files before StartMissionRun.";
    if (!existsSync(s.path("validation-contract.md"))) return "validation-contract.md is missing from the mission folder.";
    if (!existsSync(s.path("validation-state.json"))) return "validation-state.json is missing from the mission folder.";
    const names = new Set<string>();
    for (const f of features) {
      if (isValidatorSkill(f.skillName) || f.status === "cancelled" || names.has(f.skillName)) continue;
      names.add(f.skillName);
      const file = s.path("skills", f.skillName, "SKILL.md");
      if (!existsSync(file)) return `Worker skill ${f.skillName} (feature ${f.id}) is missing: write skills/${f.skillName}/SKILL.md in the mission folder.`;
      const sk = parseSkillFile(file, readFileSync(file, "utf8"), "dynamic");
      if (sk.status !== "enabled") return `Worker skill ${f.skillName} is not usable: ${sk.errors.join("; ") || sk.status}.`;
      if (sk.name !== f.skillName) return `Worker skill folder ${f.skillName} must declare name: ${f.skillName} in its frontmatter (found "${sk.name}").`;
    }
    const deps = dependencyProblem(features);
    if (deps) return `features.json is invalid: ${deps}.`;
    const st = s.readState();
    if (st?.missionBranch && isRemoteMachine(this.d.orchestrator.settings().machine)) return `This mission has parallel work on branch ${st.missionBranch}. Finish it on this machine, or clear the remote machine setting.`;
    const all = s.handoffs();
    // Parallel workers can finish together, so every handoff of the latest run is checked, not only the last one.
    const runStart = s.readLog().filter((e) => e.type === "mission_run_started" || e.type === "mission_resumed").at(-1)?.timestamp;
    const latestRun = runStart ? all.filter((h) => Date.parse(h.timestamp) >= Date.parse(runStart)) : [];
    if ([all.at(-1), ...latestRun].some((h) => h && needsAttention(h) && !this.handoffDealtWith(h))) {
      return "The latest handoff reports issues, undone work or a non-success result. Review it, then call DismissHandoffItems with a justification for each item, or edit features.json / mission.md to address it, before StartMissionRun.";
    }
    return null;
  }

  private handoffDealtWith(h: HandoffRecord): boolean {
    const t = Date.parse(h.timestamp);
    if (this.store.readLog().some((e) => e.type === "handoff_items_dismissed" && Date.parse(e.timestamp) >= t)) return true;
    return this.store.mtime("features.json") > Math.max(t, this.store.systemFeaturesMtime()) || this.store.mtime("mission.md") > t;
  }

  scopeExceeded(): boolean {
    const st = this.store.readState();
    if (!st || st.scopeGrowthPaused) return false;
    const live = this.store.features().filter((f) => !isValidatorSkill(f.skillName) && f.status !== "cancelled").length;
    return live > this.d.limits.scopeGrowthMultiplier * st.initialFeatureCount && live - st.initialFeatureCount >= this.d.limits.scopeGrowthMinAdded;
  }

  // ---------- snapshot ----------

  snapshot(): Record<string, unknown> {
    const st = this.store.readState();
    const fs = this.store.features();
    const focusIdx = fs.findIndex((f) => f.status === "in_progress") >= 0 ? fs.findIndex((f) => f.status === "in_progress") : fs.findIndex((f) => f.status === "pending");
    const brief = (f?: Feature) => (f ? { id: f.id, description: f.description, milestone: f.milestone, status: f.status } : null);
    const lastDone = [...fs].reverse().find((f) => f.status === "completed");
    const log = this.store.readLog();
    const validated = new Set(log.filter((e) => e.type === "milestone_validation_triggered").map((e) => e.milestone));
    const impl = fs.filter((f) => !isValidatorSkill(f.skillName));
    const open = new Set(impl.filter((f) => f.status !== "cancelled").map((f) => f.milestone));
    const s = this.d.orchestrator.settings();
    const per = (s.skipScrutiny ? 0 : 1) + (s.skipUserTesting ? 0 : 1);
    const running = [...this.workers.values()].map((w) => ({ workerSessionId: w.id, featureId: w.featureId, description: w.description, startedAt: w.startedAt, step: w.step }));
    return {
      state: st?.state ?? "planning", updatedAt: st?.updatedAt,
      activeTime: { elapsedMs: Date.now() - this.startedAt, measuredAtMs: Date.now() },
      counts: {
        total: fs.length, completed: fs.filter((f) => f.status === "completed").length, cancelled: fs.filter((f) => f.status === "cancelled").length,
        estimatedValidation: [...open].filter((m) => !validated.has(m)).length * per,
      },
      featureWindow: { previous: brief(lastDone), focus: brief(fs[focusIdx]), next: brief(fs.slice(focusIdx + 1).find((f) => f.status === "pending")) },
      currentWorkerId: running[0]?.workerSessionId ?? null,
      currentWorker: running[0] ?? null,
      workers: running,
      missionBranch: st?.missionBranch ?? null,
    };
  }

  private emitProgress() { this.d.onProgress?.(this.snapshot()); }

  tokens(): TokenUsage {
    const ids = this.store.features().flatMap((f) => f.workerSessionIds ?? []);
    const w = this.d.workerUsage(ids);
    const o = this.d.orchestrator.tokenUsage();
    return {
      inputTokens: w.inputTokens + o.inputTokens, outputTokens: w.outputTokens + o.outputTokens, cacheCreationTokens: w.cacheCreationTokens + o.cacheCreationTokens,
      cacheReadTokens: w.cacheReadTokens + o.cacheReadTokens, thinkingTokens: w.thinkingTokens + o.thinkingTokens,
    };
  }

  // ---------- the run ----------

  async run(input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const s = this.store;
    const refusal = this.runGates();
    if (refusal) return this.result(false, refusal, refusal);
    const before = s.readState();
    const resuming = before?.state === "paused";
    const handle: RunHandle = {
      sessionId: this.d.orchestrator.sessionId,
      pause: (reason) => { this.pauseRequest = reason; for (const w of this.workers.values()) w.interrupt("pause"); },
      killWorker: (id) => { const w = this.workers.get(id); if (!w) return false; w.interrupt("kill"); return true; },
      currentWorkerId: () => this.workers.keys().next().value,
    };
    this.startedAt = Date.now();
    this.pauseRequest = undefined;
    this.d.register(handle);
    this.d.wake.acquire();
    const hb = setInterval(() => {
      const e = s.log("mission_heartbeat", {});
      s.writeState({});
      this.d.notify({ type: "mission_heartbeat", timestamp: e.timestamp });
    }, this.d.limits.heartbeatMs);
    const onAbort = () => handle.pause("user_interrupt");
    signal.addEventListener("abort", onAbort);
    try {
      if (resuming && before?.pauseReason === "feature_retry_limit_exceeded") {
        const bonus = { ...(before.featureRetryBudgetBonus ?? {}) };
        for (const f of s.features()) if (!doneStatus(f) && attemptsOf(f) >= this.limit(f)) bonus[f.id] = (bonus[f.id] ?? 0) + this.d.limits.retryLimit;
        s.writeState({ featureRetryBudgetBonus: bonus });
      }
      if (!s.readState()) s.writeState({ state: "initializing", initialFeatureCount: s.features().filter((f) => !isValidatorSkill(f.skillName)).length });
      else if (!s.readState()!.initialFeatureCount) s.writeState({ initialFeatureCount: s.features().filter((f) => !isValidatorSkill(f.skillName)).length });
      s.setState("initializing");
      this.d.notify({ type: "mission_state_changed", state: "initializing", updatedAt: s.readState()?.updatedAt });
      const parallel = this.usesWorkspace();
      const resumeIds: string[] = [];
      for (const inProg of s.features().filter((f) => f.status === "in_progress")) {
        if (resuming && inProg.currentWorkerSessionId && !input.restartFeature && (parallel || !input.resumeWorkerSessionId || input.resumeWorkerSessionId === inProg.currentWorkerSessionId)) {
          resumeIds.push(inProg.currentWorkerSessionId);
        } else {
          this.requeue(inProg, input.restartFeature ? "restart_feature" : "orphan_cleanup");
        }
      }
      if (resuming) s.log("mission_resumed", { ...(resumeIds[0] ? { resumeWorkerSessionId: resumeIds[0] } : {}), ...(resumeIds.length > 1 ? { resumeWorkerSessionIds: resumeIds } : {}) });
      else s.log("mission_run_started", {});
      this.setState("running");
      return parallel ? await this.loopParallel(input, resumeIds) : await this.loop(input, resumeIds[0]);
    } finally {
      clearInterval(hb);
      signal.removeEventListener("abort", onAbort);
      this.d.wake.release();
      this.d.unregister(handle);
    }
  }

  private limit(f: Feature) { return Math.min(this.d.limits.retryLimit + (this.store.readState()?.featureRetryBudgetBonus?.[f.id] ?? 0), effectivePolicy().missions?.maxWorkerAttempts ?? Infinity); }

  private setState(state: MissionState, pauseReason?: string) {
    const st = this.store.setState(state, pauseReason);
    this.d.notify({ type: "mission_state_changed", state, updatedAt: st.updatedAt });
    this.emitProgress();
  }

  private pause(reason: string, extra: Partial<{ scopeGrowthPaused: boolean }> = {}): string {
    this.store.log("mission_paused", { pauseReason: reason });
    const st = this.store.writeState({ state: "paused", pauseReason: reason, ...extra });
    this.d.notify({ type: "mission_state_changed", state: "paused", updatedAt: st.updatedAt });
    this.emitProgress();
    return reason;
  }

  private requeue(f: Feature, failureReason: string) {
    this.store.log("worker_failed", { workerSessionId: f.currentWorkerSessionId, featureId: f.id, failureReason });
    this.store.updateFeature(f.id, (x) => { x.status = "pending"; delete x.currentWorkerSessionId; });
  }

  private async loop(input: RunInput, resumeId: string | undefined): Promise<RunResult> {
    const s = this.store;
    let first = true;
    for (;;) {
      if (this.pauseRequest) return this.finishPaused(this.pauseRequest);
      const policy = effectivePolicy().missions;
      if (policy?.enabled === false || policy?.maxConcurrentRuns === 0 || (policy?.maxFeatures !== undefined && s.features().filter((f) => f.status !== "cancelled").length > policy.maxFeatures)) return this.finishPaused(this.pause("policy_limit_reached"));
      let features = s.features();
      if (features.every(doneStatus)) {
        this.setState("completed");
        return this.result(true, "Every feature is complete: the mission is completed.");
      }
      if (this.scopeExceeded()) return this.finishPaused(this.pause("scope_growth_limit_exceeded", { scopeGrowthPaused: true }));

      let feature: Feature | undefined;
      let resume = false;
      if (first && resumeId) { feature = features.find((f) => f.currentWorkerSessionId === resumeId); resume = !!feature; }
      first = false;
      if (!feature) {
        feature = features.find((f) => f.status === "pending");
        if (!feature) return this.finishAttention("No pending feature is left, but the queue is not complete (a feature is in progress or blocked). Review features.json.");
        if (attemptsOf(feature) >= this.limit(feature)) return this.finishPaused(this.pause("feature_retry_limit_exceeded"));
      }
      const outcome = await this.runWorker(feature, resume, input);
      const verdict = await this.afterWorker(feature, outcome);
      if (verdict) return verdict();
    }
  }

  // ---------- parallel run ----------

  private workerLimit() {
    const ms = this.d.orchestrator.settings();
    return isRemoteMachine(ms.machine) ? 1 : clampWorkers(ms.maxParallelWorkers);
  }

  /** A mission that started on a mission branch stays on it, even if the limit is later set back to 1. */
  private usesWorkspace() { return !!this.store.readState()?.missionBranch || this.workerLimit() > 1; }

  private workspace() {
    const st = this.store.readState()!;
    const wd = st.workingDirectory || this.d.orchestrator.cwd;
    return new MissionWorkspace(this.d.worktrees(), wd, st.missionId, this.d.log);
  }

  private async loopParallel(input: RunInput, resumeIds: string[]): Promise<RunResult> {
    const s = this.store;
    type Finished = { feature: Feature; outcome?: WorkerOutcome & { workerId: string }; startError?: string };
    const running = new Map<string, Promise<Finished>>();
    let integration: { branch: string; path: string; cwd: string };
    try {
      const st = s.readState()!;
      integration = await this.workspace().ensureIntegration({ branch: st.missionBranch, path: st.integrationPath });
      s.writeState({ missionBranch: integration.branch, integrationPath: integration.path });
    } catch (e) {
      return this.finishAttention(`Rigwell could not prepare the mission branch: ${(e as Error).message}`);
    }
    const start = (feature: Feature, resume: boolean) => {
      running.set(feature.id, (async (): Promise<Finished> => {
        try {
          const place = resume ? undefined : await this.workerPlace(feature, integration);
          return { feature, outcome: await this.runWorker(feature, resume, input, place) };
        } catch (e) { return { feature, startError: (e as Error).message }; }
      })());
    };
    // Work that finished before a crash is merged first.
    let stop = await this.mergeFinished(integration.path);
    for (const id of resumeIds) {
      const f = s.features().find((x) => x.currentWorkerSessionId === id);
      if (f) start(f, true);
    }
    for (;;) {
      if (!stop && !this.pauseRequest) {
        const policy = effectivePolicy().missions;
        if (policy?.enabled === false || policy?.maxConcurrentRuns === 0 || (policy?.maxFeatures !== undefined && s.features().filter((f) => f.status !== "cancelled").length > policy.maxFeatures)) stop = () => this.finishPaused(this.pause("policy_limit_reached"));
        else if (this.scopeExceeded()) stop = () => this.finishPaused(this.pause("scope_growth_limit_exceeded", { scopeGrowthPaused: true }));
      }
      if (!stop && !this.pauseRequest) {
        for (const f of pickRunnable(s.features(), new Set(running.keys()), this.workerLimit())) {
          if (attemptsOf(f) >= this.limit(f)) { stop = () => this.finishPaused(this.pause("feature_retry_limit_exceeded")); break; }
          start(f, false);
        }
      }
      if (!running.size) {
        if (this.pauseRequest) return this.finishPaused(this.pauseRequest);
        if (stop) return stop();
        const features = s.features();
        if (features.every(doneStatus)) {
          await this.workspace().removeWorktree(integration.path, false);
          s.writeState({ integrationPath: undefined });
          this.setState("completed");
          return this.result(true, `Every feature is complete: the mission is completed. The merged work is on branch ${integration.branch}. Your own branch did not change. Review that branch, then merge it when you are ready.`);
        }
        return this.finishAttention("No feature can start. A feature may wait on a cancelled or unfinished dependency. Review features.json.");
      }
      const done = await Promise.race(running.values());
      running.delete(done.feature.id);
      if (done.startError !== undefined) {
        s.log("worker_failed", { featureId: done.feature.id, failureReason: `start_failed: ${done.startError}` });
        stop ??= () => this.finishAttention(`Rigwell could not start the worker for ${done.feature.id}: ${done.startError}`);
        continue;
      }
      const verdict = await this.afterWorker(done.feature, done.outcome!);
      stop ??= verdict;
      const merged = await this.mergeFinished(integration.path);
      stop ??= merged;
    }
  }

  private async workerPlace(f: Feature, integration: { branch: string; cwd: string }) {
    // Validators check the merged result, in the mission branch folder.
    if (isValidatorSkill(f.skillName)) return { cwd: integration.cwd, isolated: true };
    const w = crypto.randomUUID();
    const wt = await this.workspace().createWorker(f.id, w, integration.branch);
    return { workerId: w, cwd: wt.cwd, isolated: true, branch: wt.branch, worktree: wt.path };
  }

  /** Merges finished features one at a time. A failed merge stops only that feature and asks for attention. */
  private async mergeFinished(integrationPath: string): Promise<(() => RunResult) | undefined> {
    const s = this.store;
    const problems: string[] = [];
    for (const f of s.features().filter((x) => x.status === "completed" && x.mergeStatus === "pending")) {
      const ws = this.workspace();
      const r = await ws.merge(integrationPath, f.workBranch!, f.id);
      if (r.ok) {
        s.updateFeature(f.id, (x) => { x.mergeStatus = "merged"; });
        s.log("feature_merged", { featureId: f.id, branch: f.workBranch });
        const location = Object.values(s.readState()?.workerLocations ?? {}).find((l) => l.branch === f.workBranch);
        if (location?.worktree) await ws.removeWorktree(location.worktree, true);
        this.maybeInsertValidators(f.milestone);
      } else {
        s.updateFeature(f.id, (x) => { x.status = "pending"; x.mergeStatus = "conflict"; delete x.completedWorkerSessionId; });
        s.log("merge_conflict", { featureId: f.id, branch: f.workBranch, files: r.files, conflict: r.conflict });
        // The work is committed on its branch, so the folder can go. The branch stays for review.
        const kept = Object.values(s.readState()?.workerLocations ?? {}).find((l) => l.branch === f.workBranch);
        if (kept?.worktree) await ws.removeWorktree(kept.worktree, false);
        problems.push(r.conflict
          ? `Feature ${f.id} could not merge. Conflicting files: ${r.files.join(", ")}.`
          : `Feature ${f.id} could not merge: ${r.message}.`);
        problems.push(`Its work is kept on branch ${f.workBranch}. Rigwell did not resolve this. Review it, then change the plan or call StartMissionRun to rebuild the feature on the merged code.`);
      }
      this.emitProgress();
    }
    return problems.length ? () => this.finishAttention(problems.join(" ")) : undefined;
  }

  private finishPaused(reason: string): RunResult {
    const st = this.store.readState();
    if (st?.state !== "paused") this.pause(reason);
    const r = this.store.readState()?.pauseReason ?? reason;
    return this.result(true, `The mission is paused (${r}). ${this.pauseHelp(r)}`);
  }

  private pauseHelp(r: string): string {
    if (r === "feature_retry_limit_exceeded") return "A feature used all its worker attempts. Call StartMissionRun again to grant it more, or change the plan first.";
    if (r === "scope_growth_limit_exceeded") return "The plan grew far beyond its original size. Review features.json, then call StartMissionRun to continue.";
    if (r === "unrecoverable_usage_402") return "The model provider reported a billing or quota problem that retrying will not clear. Fix it, then call StartMissionRun.";
    return "Call StartMissionRun to resume.";
  }

  private finishAttention(message: string): RunResult {
    this.setState("orchestrator_turn");
    return this.result(true, message);
  }

  private result(ok: boolean, message: string, refusal?: string): RunResult {
    const st = this.store.readState();
    const all = this.store.handoffs();
    const reviewed = st?.lastReviewedHandoffCount ?? 0;
    const recent = all.slice(reviewed);
    if (ok && st) this.store.writeState({ lastReviewedHandoffCount: all.length });
    const fs = this.store.features();
    return {
      ok, ...(refusal ? { refusal } : {}), state: this.store.stateName(), pauseReason: this.store.readState()?.pauseReason, message,
      handoffs: recent, latestHandoff: all.at(-1),
      counts: { total: fs.length, completed: fs.filter((f) => f.status === "completed").length, pending: fs.filter((f) => f.status === "pending").length, cancelled: fs.filter((f) => f.status === "cancelled").length },
      progress: this.snapshot(), tokenUsage: this.tokens(),
    };
  }

  // ---------- one worker ----------

  private pickModel(f: Feature): { modelId: string; effort?: string; substitutedFrom?: string } {
    const o = this.d.orchestrator;
    const ms = o.settings();
    const validator = isValidatorSkill(f.skillName);
    const want = (validator ? ms.validationWorkerModel ?? ms.workerModel : ms.workerModel) ?? o.modelId();
    const effort = (validator ? ms.validationWorkerReasoningEffort ?? ms.workerReasoningEffort : ms.workerReasoningEffort) ?? o.reasoningEffort();
    if (ms.machine || this.d.modelExists(want)) return { modelId: want, effort };
    return { modelId: o.modelId(), effort, substitutedFrom: want };
  }

  private async runWorker(f: Feature, resume: boolean, input: RunInput, place?: { workerId?: string; cwd: string; isolated: boolean; branch?: string; worktree?: string }): Promise<WorkerOutcome & { workerId: string }> {
    const s = this.store;
    const o = this.d.orchestrator;
    const st = s.readState()!;
    const ms = o.settings();
    const stored = st.workerLocations?.[f.currentWorkerSessionId ?? ""];
    const isolated = place?.isolated ?? (resume && !!stored?.isolated);
    const location = resume ? st.workerLocations?.[f.currentWorkerSessionId ?? ""] : undefined;
    const machine = location ? location.machine : ms.machine;
    const cwd = place?.cwd ?? location?.cwd ?? (machine ? ms.workerWorkingDirectory || st.workingDirectory || o.cwd : st.workingDirectory || o.cwd);
    const pick = this.pickModel(f);
    let workerId = f.currentWorkerSessionId ?? "";
    if (!resume) {
      workerId = place?.workerId ?? crypto.randomUUID();
      s.writeState({ workerLocations: { ...s.readState()?.workerLocations, [workerId]: { machine, cwd, ...(place ? { isolated: true } : {}), ...(place?.branch ? { branch: place.branch, worktree: place.worktree } : {}) } } });
      s.updateFeature(f.id, (x) => {
        x.status = "in_progress"; x.currentWorkerSessionId = workerId; x.workerSessionIds = [...(x.workerSessionIds ?? []), workerId];
        delete x.mergeStatus;
        if (place?.branch) x.workBranch = place.branch; else delete x.workBranch;
      });
      s.log("worker_selected_feature", { workerSessionId: workerId, featureId: f.id });
      s.log("worker_started", { workerSessionId: workerId, featureId: f.id, modelId: pick.modelId, ...(pick.substitutedFrom ? { substitutedFromModelId: pick.substitutedFrom } : {}) });
    }
    const startedAt = Date.now();
    let step: string | undefined;
    this.d.notify({ type: "mission_worker_started", workerSessionId: workerId, featureId: f.id, description: f.description, startedAt });
    const h = this.d.spawn({
      sessionId: workerId, resume, cwd, modelId: pick.modelId, reasoningEffort: pick.effort, missionId: st.missionId, role: "worker",
      ...(machine ? { machine, missionDir: s.dir, feature: f, extraMessage: input.messageToWorker } : {}),
      prompt: resume ? resumePrompt(input.messageToWorker) : workerPrompt(s.dir, f, workerId, cwd, input.messageToWorker, isolated),
      wrapTools: this.d.workerWrap(workerId), inactivityMs: this.d.limits.inactivityMs, startGraceMs: this.d.limits.startGraceMs,
      retryBaseDelayMs: this.d.retryBaseDelayMs, log: this.d.log,
      onActivity: (n) => {
        const next = stepFrom(n);
        if (next !== undefined) { step = next || undefined; const live = this.workers.get(workerId); if (live) live.step = step; }
        this.d.notify({ type: "mission_worker_activity", workerSessionId: workerId, activity: n.type, ...(next !== undefined ? { step: next } : {}) });
      },
    });
    this.workers.set(workerId, { id: workerId, interrupt: h.interrupt, featureId: f.id, description: f.description, startedAt, step });
    this.emitProgress();
    if (this.pauseRequest) h.interrupt("pause");
    const outcome = await h.done;
    this.workers.delete(workerId);
    s.addWorkerTranscript({ workerSessionId: workerId, featureId: f.id, status: outcome.status, messages: skeleton(outcome.messages) });
    return { ...outcome, workerId };
  }

  /** Handles the end of a worker. Returns a step that stops the run, or undefined to carry on. The step runs after other workers finish. */
  private async afterWorker(f: Feature, o: WorkerOutcome & { workerId: string }): Promise<(() => RunResult) | undefined> {
    const s = this.store;
    const cur = () => s.features().find((x) => x.id === f.id);
    const rec = s.handoffFor(o.workerId);
    if (o.status === "interrupted") {
      if (o.interruptReason === "kill") {
        const feat = cur();
        s.log("worker_failed", { workerSessionId: o.workerId, featureId: f.id, failureReason: "user_killed" });
        if (feat && feat.status === "in_progress") s.updateFeature(f.id, (x) => { x.status = "pending"; delete x.currentWorkerSessionId; });
        this.d.notify({ type: "mission_worker_completed", workerSessionId: o.workerId, exitCode: 1 });
        return () => this.finishAttention(`The worker for ${f.id} was killed by the user and the feature was requeued. Review, then call StartMissionRun.`);
      }
      s.log("worker_paused", { workerSessionId: o.workerId, featureId: f.id });
      return () => this.finishPaused(this.pauseRequest ?? "user_paused");
    }
    if (rec) {
      s.log("worker_completed", { workerSessionId: o.workerId, featureId: f.id, ...rec.handoff, successState: rec.successState, exitCode: 0 });
      this.d.notify({ type: "mission_worker_completed", workerSessionId: o.workerId, exitCode: 0 });
      if (needsAttention(rec)) {
        return () => this.finishAttention(`Worker for ${f.id} finished with ${rec.successState}${rec.returnToOrchestrator ? " and asked to return to the orchestrator" : ""}. Review the handoff, then dismiss items or edit the plan and call StartMissionRun.`);
      }
      this.maybeInsertValidators(f.milestone);
      this.emitProgress();
      return undefined;
    }
    // No handoff: the worker exited, crashed or stalled.
    const reason = o.status === "timeout" ? "inactivity_timeout" : o.status === "error" ? `crash: ${o.errorMessage ?? "unknown error"}` : "exited_without_handoff";
    // A worker session that died on its own is a process exit the clients should hear about (spec 19.1).
    if (o.status === "error") this.d.notify({ type: "session_process_exited", message: `Worker session ${o.workerId} stopped unexpectedly: ${o.errorMessage ?? "unknown error"}`, timestamp: new Date().toISOString(), workerSessionId: o.workerId });
    const feat = cur();
    s.log("worker_failed", { workerSessionId: o.workerId, featureId: f.id, failureReason: reason });
    if (feat && feat.status === "in_progress") s.updateFeature(f.id, (x) => { x.status = "pending"; delete x.currentWorkerSessionId; });
    this.d.notify({ type: "mission_worker_completed", workerSessionId: o.workerId, exitCode: 1 });
    if (o.status === "error" && BILLING.test(o.errorMessage ?? "")) {
      return () => this.finishPaused(this.pause("unrecoverable_usage_402"));
    }
    return () => this.finishAttention(
      o.status === "timeout" ? `The worker for ${f.id} was silent too long and was failed; the feature was requeued. Call StartMissionRun to retry.`
        : o.status === "error" ? `The worker for ${f.id} crashed (${o.errorMessage ?? "unknown error"}); the feature was requeued. Call StartMissionRun to retry.`
          : `The worker for ${f.id} ended without calling EndFeatureRun; the feature was requeued. Resume or retry with StartMissionRun.`,
    );
  }

  /** Milestone validation (spec §15.7): once every implementation feature of a milestone is complete, queue the validators on top. */
  private maybeInsertValidators(milestone: string) {
    const s = this.store;
    if (s.readLog().some((e) => e.type === "milestone_validation_triggered" && e.milestone === milestone)) return;
    const all = s.features();
    const impl = all.filter((x) => x.milestone === milestone && !isValidatorSkill(x.skillName) && x.status !== "cancelled");
    if (!impl.length || impl.some((x) => x.status !== "completed" || (x.mergeStatus && x.mergeStatus !== "merged"))) return;
    const ms = this.d.orchestrator.settings();
    const add: Feature[] = [];
    if (!ms.skipScrutiny) add.push({
      id: `scrutiny-validator-${milestone}`, skillName: "scrutiny-validator", milestone, status: "pending",
      description: `Scrutiny validation of milestone ${milestone}: review the changes, run the test suites and report findings.`,
      expectedBehavior: ["All tests pass", "No blocking issues in the milestone's changes"], fulfills: [],
    });
    if (!ms.skipUserTesting) add.push({
      id: `user-testing-validator-${milestone}`, skillName: "user-testing-validator", milestone, status: "pending",
      description: `User-testing validation of milestone ${milestone}: exercise the behavior in validation-contract.md as a user would and report findings.`,
      expectedBehavior: ["Every contract assertion for this milestone holds"], fulfills: [],
    });
    s.log("milestone_validation_triggered", { milestone, inserted: add.map((a) => a.id) });
    if (add.length) s.writeFeatures([...add, ...all]);
  }
}

// ---------- worker messages (own text) ----------

const VALIDATOR_ROLE: Record<string, string> = {
  "scrutiny-validator": "You are the scrutiny validator for a milestone. Review the code changes made for the milestone's features, run the project's build, tests and linters, and look for defects, gaps against the validation contract, and weak tests. Record findings as discoveredIssues in your handoff.",
  "user-testing-validator": "You are the user-testing validator for a milestone. Exercise the milestone's behavior the way a user would, following validation-contract.md, and record what you observed. Record failures as discoveredIssues in your handoff.",
};

export function workerPrompt(missionDir: string, f: Feature, workerId: string, cwd: string, extra?: string, isolated = false): string {
  const skill = isValidatorSkill(f.skillName)
    ? VALIDATOR_ROLE[f.skillName]
    : `Load your skill from ${join(missionDir, "skills", f.skillName, "SKILL.md")} and follow it.`;
  const list = (t: string, a?: string[]) => (a?.length ? `${t}:\n${a.map((x) => `- ${x}`).join("\n")}\n` : "");
  return [
    `You are a worker in a mission. Mission folder: ${missionDir}`,
    `Your session id: ${workerId}`,
    `Working folder (the repository): ${cwd}`,
    `Assigned feature: ${f.id} (milestone ${f.milestone})`,
    `Description: ${f.description}`,
    list("Preconditions", f.preconditions), list("Expected behavior", f.expectedBehavior), list("Fulfills", f.fulfills),
    `Before you start, read ${join(missionDir, "mission.md")} and ${join(missionDir, "AGENTS.md")}. ${skill}`,
    `Rules: do not edit features.json or any file in the mission folder that the system owns. Do only this feature. Commit your work when the skill says to.`,
    isolated ? `This run uses a separate code copy on its own branch. Commit all your work before you call EndFeatureRun: uncommitted work cannot be merged.${f.fileAreas?.length ? ` Change only these file areas: ${f.fileAreas.join(", ")}.` : ""}` : "",
    `You must finish by calling EndFeatureRun exactly once with your result and handoff. A run that ends without it counts as a failure.`,
    extra ? `Message from the orchestrator: ${extra}` : "",
  ].filter(Boolean).join("\n");
}

export function resumePrompt(extra?: string): string {
  return `Your run was paused and is now resumed. Check git status to see what is already done in the working folder, carry on with your assigned feature, and finish by calling EndFeatureRun.${extra ? `\nMessage from the orchestrator: ${extra}` : ""}`;
}
