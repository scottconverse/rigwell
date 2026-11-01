// Runs one prompt as a headless session in-process (spec §16.4 steps 1-7). The connection cannot prompt:
// anything that would ask the user is denied by the session and the run carries on.
import { createConnection } from "../daemon/connection.ts";
import { loadSettings } from "../storage/settings.ts";
import { findModel, resolveModels } from "../storage/models.ts";
import type { AutonomyLevel } from "../core/types.ts";
import type { FailureReason } from "./store.ts";

export interface HeadlessRequest {
  cwd: string;
  title: string;
  prompt: string;
  modelId?: string;
  reasoningEffort?: string;
  autonomy: AutonomyLevel;
  /** Add the prompt to this existing session instead (its own model is used). */
  targetSessionId?: string;
  startTimeoutMs: number;
  maxRunMs: number;
}

export interface HeadlessResult {
  sessionId?: string;
  ok: boolean;
  failureReason?: FailureReason;
  errorMessage?: string;
  text: string;
  modelFallback?: { requested: string; used: string; reason: string };
}

export type HeadlessRunner = (req: HeadlessRequest) => Promise<HeadlessResult>;

export function createHeadlessRunner(opts: { log?: (m: string) => void; retryBaseDelayMs?: number } = {}): HeadlessRunner {
  return async (req) => {
    const loaded = loadSettings({ cwd: req.cwd });
    const models = resolveModels(loaded.settings);
    let modelId = req.modelId;
    let modelFallback: HeadlessResult["modelFallback"];
    if (!req.targetSessionId) {
      const dflt = loaded.settings.sessionDefaultSettings?.model ?? models[0]?.id;
      if (modelId && !findModel(models, modelId)) {
        if (!dflt || !findModel(models, dflt)) return { ok: false, failureReason: "dispatch_exception", errorMessage: `model ${modelId} does not resolve and no default model is configured`, text: "" };
        modelFallback = { requested: modelId, used: dflt, reason: "model_not_found" };
        modelId = dflt;
      }
    }

    let reqN = 0, sessionId: string | undefined, text = "", errorMessage: string | undefined, timedOut = false;
    const waiters = new Map<string, (m: any) => void>();
    let turnDone!: (reason: string) => void;
    const finished = new Promise<string>((r) => (turnDone = r));
    const conn = createConnection((line) => {
      const m = JSON.parse(line);
      if (m.type === "response") return waiters.get(m.id)?.(m);
      const n = m.params?.notification;
      if (!n) return;
      if (n.type === "assistant_text_delta") text += n.textDelta;
      else if (n.type === "error") { errorMessage = n.message; if (/time(d)?[ -]?out/i.test(String(n.message))) timedOut = true; }
      else if (n.type === "agent_turn_completed") turnDone(n.reason);
    }, { canPrompt: false, log: opts.log, retryBaseDelayMs: opts.retryBaseDelayMs, forced: { autonomyLevel: req.autonomy, modelId } });
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<any>((res) => {
        const id = `auto-${++reqN}`;
        waiters.set(id, res);
        conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      });
    const fail = (failureReason: FailureReason, msg?: string): HeadlessResult =>
      ({ sessionId, ok: false, failureReason, errorMessage: msg ?? errorMessage, text, modelFallback });

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startTimeout = new Promise<"timeout">((r) => (startTimer = setTimeout(() => r("timeout"), req.startTimeoutMs)));
      const init = await Promise.race([
        req.targetSessionId
          ? call("load_session", { sessionId: req.targetSessionId, cwd: req.cwd })
          : call("initialize_session", { machineId: "default", cwd: req.cwd, title: req.title, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) }),
        startTimeout,
      ]);
      if (init === "timeout") return fail("dispatch_timed_out", "session did not start in time");
      if (init.error) return fail("dispatch_exception", init.error.message);
      sessionId = init.result.sessionId;
      const added = await call("add_user_message", { text: req.prompt });
      if (added.error) return fail("dispatch_exception", added.error.message);
      let maxTimer: ReturnType<typeof setTimeout> | undefined;
      const reason = await Promise.race([
        finished,
        new Promise<string>((r) => (maxTimer = setTimeout(() => { timedOut = true; void call("interrupt_session", {}); r("max_duration"); }, req.maxRunMs))),
      ]);
      clearTimeout(maxTimer);
      await call("close_session", { reason: "other" });
      if (reason === "completed") return { sessionId, ok: true, text, modelFallback };
      if (timedOut) return fail("model_timed_out");
      return fail(reason === "cancelled" ? "closed_before_completion" : "agent_error", errorMessage ?? `turn ended: ${reason}`);
    } catch (e) {
      return fail("dispatch_exception", (e as Error).message);
    } finally {
      clearTimeout(startTimer);
      void conn.shutdown().catch(() => {});
    }
  };
}
