import type { WorkerHandle, WorkerOutcome, WorkerRequest } from "../missions/worker.ts";
import type { RpcClient } from "../sdk/client.ts";
import { zeroUsage } from "../core/types.ts";
import { missionPlanFiles, mergeMissionLibrary } from "./mission-worker.ts";
import { resumePrompt } from "../missions/runner.ts";
import { RemoteSessionStore } from "./sessions.ts";

export function spawnRemoteWorkerSession(req: WorkerRequest): WorkerHandle {
  let client: RpcClient | undefined, interruptReason: string | undefined, reason: string | undefined;
  let text = "", errorMessage: string | undefined, timedOut = false, initialized = false, finished = false;
  let remoteCwd = req.cwd;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  const arm = (ms = req.inactivityMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; stop(); }, ms);
  };
  const done = (async (): Promise<WorkerOutcome> => {
    const outcome: WorkerOutcome = { status: "error", text: "", messages: [], tokenUsage: zeroUsage() };
    try {
      if (!req.missionDir || !req.feature) throw new Error("Remote mission worker requires its approved plan and feature");
      arm(req.inactivityMs + req.startGraceMs);
      const opening = (req.connectMachine ?? (async (name) => (await import("./bootstrap.ts")).connectMachine(name, { log: req.log })))(req.machine!).then(async (opened) => {
        if (timedOut || interruptReason) { await opened.close(); throw new Error("Remote worker startup cancelled"); }
        client = opened; return opened;
      });
      await Promise.race([opening, stopped.then(() => { throw new Error("Remote worker startup cancelled"); })]);
      if (!client) throw new Error("Remote worker connection unavailable");
      const remote = client;
      const plan = missionPlanFiles(req.missionDir);
      let libraryBaseline = Object.fromEntries(Object.entries(plan).filter(([path]) => path.startsWith("library/")));
      const syncLibrary = async () => {
        const files = await remote.request("mission_worker_library_snapshot", { sessionId: req.sessionId });
        libraryBaseline = mergeMissionLibrary(req.missionDir!, libraryBaseline, files);
      };
      const end = req.wrapTools([], { workingDirectory: () => remoteCwd, verifyCommit: async (repo, commit) => {
        const valid = await remote.request<boolean>("mission_worker_verify_commit", { repo, commit });
        if (interruptReason || timedOut) throw new Error("Worker interrupted before its handoff was recorded");
        return valid;
      } }).find((t) => t.name === "EndFeatureRun");
      if (!end) throw new Error("Remote mission worker has no completion tool");
      const abort = new AbortController();
      remote.onRequest = async (method, p) => {
        if (method !== "owned_mission_tool") return { selectedOption: "cancel", cancelled: true, answers: [], trust: false };
        if (!initialized || interruptReason || timedOut || p.sessionId !== req.sessionId || !p.input || typeof p.input !== "object" || Array.isArray(p.input)) throw new Error("Invalid remote worker tool request");
        await syncLibrary();
        return end.run(p.input as Record<string, unknown>, { cwd: remoteCwd, sessionId: req.sessionId, readFiles: new Map(), signal: abort.signal });
      };
      remote.onNotification = (_method, p) => {
        const n = p.notification;
        if (!n || finished) return;
        arm(); req.onActivity?.(n);
        if (n.type === "assistant_text_delta") text += n.textDelta;
        else if (n.type === "error") errorMessage = n.message;
        else if (n.type === "agent_turn_completed") { reason = n.reason; complete(); }
      };
      const { run: _run, ...descriptor } = end;
      const duringStartup = <T>(operation: Promise<T>) => Promise.race([operation, stopped.then(() => { throw new Error("Remote worker startup cancelled"); })]);
      const prepared = await duringStartup(remote.request<{ dir: string; cwd: string; prompt: string }>("prepare_mission_worker", { sessionId: req.sessionId, cwd: req.cwd, files: plan, tool: descriptor, feature: req.feature, extraMessage: req.extraMessage }));
      remoteCwd = prepared.cwd;
      if (timedOut || interruptReason) return { ...outcome, status: timedOut ? "timeout" : "interrupted", interruptReason };
      await duringStartup(remote.request(req.resume ? "load_session" : "initialize_session", {
        sessionId: req.sessionId, cwd: prepared.cwd, modelId: req.modelId, autonomyLevel: "high", interactionMode: "auto", autoRejectPermissionRequests: true,
        tags: [{ name: "exec" }, { name: "mission", metadata: { role: "worker", missionId: req.missionId } }],
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      }));
      initialized = true;
      const index = new RemoteSessionStore();
      index.update({ sessionId: req.sessionId, machine: req.machine!, cwd: prepared.cwd, title: `Mission worker (${req.missionId})`, updatedAt: new Date().toISOString(), pinned: false, archivedAt: null, isSubagent: true, hasUserVisibleMessages: true });
      if (interruptReason || timedOut) stop();
      else await remote.request("add_user_message", { text: req.resume ? resumePrompt(req.extraMessage) : prepared.prompt });
      const winner = await Promise.race([completed.then(() => "turn"), stopped.then(() => "stop")]);
      if (winner === "stop") { abort.abort(); await remote.request("interrupt_session", {}); }
      await remote.request("settle_session", {});
      await syncLibrary();
      const snapshot = await remote.request<{ messages: WorkerOutcome["messages"]; tokenUsage: WorkerOutcome["tokenUsage"] }>("owned_session_snapshot", {});
      index.update({ ...index.get(req.sessionId)!, tokenUsage: snapshot.tokenUsage, updatedAt: new Date().toISOString() });
      return { status: timedOut ? "timeout" : interruptReason ? "interrupted" : reason === "completed" ? "ended" : reason === "cancelled" ? "interrupted" : "error", interruptReason, errorMessage, turnReason: reason, text, ...snapshot };
    } catch (e) { return { ...outcome, text, errorMessage: (e as Error).message, interruptReason, status: timedOut ? "timeout" : interruptReason ? "interrupted" : "error" }; }
    finally {
      finished = true;
      clearTimeout(timer);
      if (initialized && client && !client.isClosed) try { await client.request("close_session", { reason: "other" }); } catch {}
      await client?.close().catch(() => {});
    }
  })();
  return { sessionId: req.sessionId, done, interrupt(value) { interruptReason ??= value; stop(); } };
}
