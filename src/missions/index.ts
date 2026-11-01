// Missions service (spec §15, local only): per-connection tool wrapping, protocol methods and notifications.
// Wire it with `attach(conn)`: pass `wrapTools` as a ConnectionOptions option and the methods as extraMethods.
// Methods (prefix rigwell.): enter_mission_mode, mission_get, mission_list, mission_pause, kill_worker_session.
// Notifications inside session_notification: mission_state_changed, mission_features_changed, mission_progress_entry,
// mission_heartbeat, mission_worker_started, mission_worker_completed.
import { readdirSync, readFileSync } from "node:fs";
import type { Session } from "../agent/session.ts";
import type { Tool, TokenUsage } from "../core/types.ts";
import { zeroUsage } from "../core/types.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { loadSettings } from "../storage/settings.ts";
import { findModel, resolveModels } from "../storage/models.ts";
import { readSessionSettings } from "../storage/session-settings.ts";
import { findSession } from "../storage/transcript.ts";
import { createEditTool } from "../tools/edit.ts";
import { createCreateTool } from "../tools/create.ts";
import { protectTools } from "./protect.ts";
import { acknowledgeFolder, checkReadiness, type Git } from "./readiness.ts";
import { DEFAULT_LIMITS, MissionRunner, type Limits, type MissionSettings, type RunHandle } from "./runner.ts";
import { MissionStore, missionDirFor, missionsRoot, type Feature } from "./store.ts";
import { orchestratorTools, workerTools } from "./tools.ts";
import { spawnWorkerSession, type WorkerSpawner } from "./worker.ts";
import { WakeLock, systemLockSpawner, type LockSpawner } from "./wakelock.ts";

export * from "./store.ts";
export { MissionRunner, DEFAULT_LIMITS } from "./runner.ts";
export { checkMissionPath, protectTools } from "./protect.ts";
export { checkReadiness, acknowledgeFolder } from "./readiness.ts";
export { WakeLock, lockCommand } from "./wakelock.ts";
export { spawnWorkerSession } from "./worker.ts";

export interface MissionConn {
  session(): Session | undefined;
  /** Emits a notification inside session_notification on this connection. */
  notify(n: Record<string, unknown>): void;
  /** Sends a request to the client (method without the prefix). Absent when nobody can answer. */
  request?(method: string, params: Record<string, unknown>): Promise<any>;
}

export interface MissionServiceOptions {
  spawn?: WorkerSpawner;
  limits?: Partial<Limits>;
  lockSpawner?: LockSpawner;
  git?: Git;
  retryBaseDelayMs?: number;
  log?: (m: string) => void;
}

type Params = Record<string, unknown>;

export function createMissionService(opts: MissionServiceOptions = {}) {
  const handles = new Map<string, RunHandle>();
  const seen = new Set<string>();
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const wake = new WakeLock(opts.lockSpawner ?? systemLockSpawner);
  const spawn = opts.spawn ?? spawnWorkerSession;

  /** Crash recovery: a stale running / initializing / orchestrator_turn state seen for the first time becomes paused. */
  function recover(store: MissionStore, sessionId: string) {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const st = store.readState();
    if (st && ["running", "initializing", "orchestrator_turn"].includes(st.state) && !handles.has(sessionId)) {
      store.log("mission_paused", { pauseReason: "crash_recovery" });
      store.writeState({ state: "paused", pauseReason: "crash_recovery" });
    }
  }

  function attach(conn: MissionConn) {
    let store: MissionStore | undefined;
    let runner: MissionRunner | undefined;
    let sink: ((snap: Record<string, unknown>) => void) | undefined;

    const sess = () => {
      const s = conn.session();
      if (!s) throw new RpcError(ErrorCodes.SESSION_DISCONNECTED, "No session");
      return s;
    };
    const storeOf = (s: Session): MissionStore => {
      if (!store) {
        store = new MissionStore(missionDirFor(s.id), {
          state: (st) => conn.notify({ type: "mission_state_changed", state: st.state, updatedAt: st.updatedAt }),
          features: (features) => conn.notify({ type: "mission_features_changed", features }),
          log: (entry) => conn.notify({ type: "mission_progress_entry", progressLog: entry }),
        });
      }
      return store;
    };
    const savedSettings = (s: Session): MissionSettings => {
      const f = findSession(s.id, s.cwd);
      return ((f && readSessionSettings(f)?.missionSettings) as MissionSettings | undefined) ?? {};
    };
    const modelExists = (s: Session, id: string) => !!findModel(resolveModels(loadSettings({ cwd: s.cwd }).settings), id);

    function runnerOf(s: Session): MissionRunner {
      if (runner) return runner;
      const st = storeOf(s);
      runner = new MissionRunner({
        store: st,
        orchestrator: {
          sessionId: s.id, cwd: s.cwd, modelId: () => s.settings.modelId, reasoningEffort: () => s.settings.reasoningEffort,
          settings: () => savedSettings(s), tokenUsage: () => s.tokenUsage,
        },
        spawn, modelExists: (id) => modelExists(s, id),
        workerWrap: (workerId) => (tools) => {
          const wd = () => st.readState()?.workingDirectory || s.cwd;
          return [...protectTools(tools, { role: "worker" }), ...workerTools({ sessionId: workerId, store: st, workingDirectory: wd })];
        },
        // The store already reports state changes; the runner's own copies are dropped.
        notify: (n) => { if (n.type !== "mission_state_changed") conn.notify(n); },
        wake, limits, retryBaseDelayMs: opts.retryBaseDelayMs ?? 1, log: opts.log,
        workerUsage: (ids) => {
          const t: TokenUsage = zeroUsage();
          const wd = st.readState()?.workingDirectory || s.cwd;
          for (const id of ids) {
            const f = findSession(id, wd);
            const u = f && (readSessionSettings(f)?.tokenUsage as TokenUsage | undefined);
            if (u) for (const k of Object.keys(t) as (keyof TokenUsage)[]) t[k] += u[k] ?? 0;
          }
          return t;
        },
        onProgress: (snap) => sink?.(snap),
        register: (h) => handles.set(h.sessionId, h),
        unregister: (h) => { if (handles.get(h.sessionId) === h) handles.delete(h.sessionId); },
      });
      return runner;
    }

    function confirm(params: Params): Promise<{ accepted: boolean; comment?: string }> {
      if (!conn.request) return Promise.resolve({ accepted: true }); // headless mission mode: nobody to ask
      const requestId = crypto.randomUUID();
      const name = params.type === "propose_mission" ? "ProposeMission" : "StartMissionRun";
      return conn.request("request_permission", {
        requestId,
        toolUses: [{ toolUse: { type: "tool_use", id: requestId, name, input: params }, confirmationType: params.type, details: params }],
        options: [{ label: "Yes", value: "proceed_once" }, { label: "No", value: "cancel" }],
      }).then((a) => ({ accepted: a?.selectedOption === "proceed_once", comment: typeof a?.comment === "string" && a.comment ? a.comment : undefined }), () => ({ accepted: false }));
    }

    function wrapTools(tools: Tool[]): Tool[] {
      const s = conn.session();
      const mission = s?.settings.interactionMode === "mission";
      if (!s || !mission) return protectTools(tools, { role: "other" });
      const st = storeOf(s);
      recover(st, s.id);
      const names = new Set(tools.map((t) => t.name));
      const base = [...tools, ...(names.has("Edit") ? [] : [createEditTool()]), ...(names.has("Create") ? [] : [createCreateTool()])];
      const prot = protectTools(base, { role: "orchestrator", onFeaturesWritten: () => conn.notify({ type: "mission_features_changed", features: st.features() }) });
      const extra = orchestratorTools({
        sessionId: s.id, cwd: s.cwd, store: () => st, runner: () => runnerOf(s), missionSettings: () => savedSettings(s), confirm,
        runningMissions: () => [...handles.keys()], notifyState: () => { const x = st.readState(); if (x) conn.notify({ type: "mission_state_changed", state: x.state, updatedAt: x.updatedAt }); },
      }).map((t) => t.name === "StartMissionRun"
        ? { ...t, async run(input: Params, ctx: any) { sink = (snap) => ctx.onProgress?.({ type: "status", text: JSON.stringify(snap) }); try { return await t.run(input, ctx); } finally { sink = undefined; } } }
        : t);
      return [...prot, ...extra];
    }

    const methods: Record<string, (p: Params) => unknown> = {
      async enter_mission_mode(p) {
        const s = sess();
        const readiness = checkReadiness(s.cwd, opts.git);
        if (readiness.status !== "ok" && p.continue !== true) {
          return { entered: false, readiness, options: ["continue", "readiness-report", "readiness-fix"] };
        }
        if (readiness.status !== "ok") acknowledgeFolder(s.cwd);
        const cfg = (loadSettings({ cwd: s.cwd }).settings.missions ?? {}) as { allowedModels?: string[]; orchestratorModel?: string; orchestratorReasoningEffort?: string };
        let switched: string | undefined;
        const patch: Record<string, unknown> = { interactionMode: "mission" };
        if (cfg.allowedModels && !cfg.allowedModels.includes(s.settings.modelId) && cfg.orchestratorModel && modelExists(s, cfg.orchestratorModel)) {
          patch.modelId = cfg.orchestratorModel;
          if (cfg.orchestratorReasoningEffort) patch.reasoningEffort = cfg.orchestratorReasoningEffort;
          switched = cfg.orchestratorModel;
        }
        s.updateSettings(patch as any);
        return { entered: true, readiness, ...(switched ? { modelSwitched: switched } : {}) };
      },
      mission_get() {
        const s = sess();
        const st = storeOf(s);
        recover(st, s.id);
        if (!st.exists()) return { state: "planning", exists: false };
        const r = runnerOf(s);
        return { exists: true, ...st.readState(), features: st.features(), handoffs: st.handoffs(), progress: r.snapshot(), progressLog: st.readLog().slice(-50), tokenUsage: r.tokens() };
      },
      mission_pause() {
        const s = sess();
        const st = storeOf(s);
        const h = handles.get(s.id);
        if (h) { h.pause("user_paused"); return { paused: true }; }
        if (st.stateName() === "planning") { st.setState("awaiting_input"); return { paused: true, state: "awaiting_input" }; }
        return { paused: false, state: st.stateName() };
      },
      kill_worker_session(p) {
        const id = p.workerSessionId;
        if (typeof id !== "string" || !id) throw new RpcError(ErrorCodes.INVALID_PARAMS, "workerSessionId is required");
        for (const h of handles.values()) if (h.currentWorkerId() === id && h.killWorker(id)) return {};
        throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `No running worker session ${id}`);
      },
      mission_list() { return { missions: listMissions() }; },
    };

    return { wrapTools, methods };
  }

  return { attach, wake, handles };
}

export function listMissions(): { sessionId: string; missionId?: string; state: string; title?: string }[] {
  let ids: string[] = [];
  try { ids = readdirSync(missionsRoot()); } catch { return []; }
  return ids.map((id) => {
    const st = new MissionStore(missionDirFor(id));
    let title: string | undefined;
    try { title = readFileSync(st.path("mission.md"), "utf8").split("\n")[0].replace(/^#\s*/, ""); } catch { /* none */ }
    return { sessionId: id, missionId: st.readState()?.missionId, state: st.stateName(), title };
  });
}

export type { Feature };
