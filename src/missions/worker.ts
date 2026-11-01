// Runs one mission worker as its own headless session through the normal connection machinery (spec §15.4):
// cwd = the mission working folder, interactionMode auto, autonomy high, permission requests auto-rejected,
// tags exec + the mission role tag. Watches the session for activity (inactivity timer) and for its end.
import { createConnection } from "../daemon/connection.ts";
import { findSession } from "../storage/transcript.ts";
import { updateSessionSettings } from "../storage/session-settings.ts";
import type { Message, TokenUsage, Tool } from "../core/types.ts";
import { zeroUsage } from "../core/types.ts";

export interface WorkerRequest {
  sessionId: string;
  /** Reload this session instead of creating it (resume after a pause). */
  resume: boolean;
  cwd: string;
  modelId: string;
  reasoningEffort?: string;
  prompt: string;
  missionId: string;
  role: "worker";
  /** Tool list rewrite for the worker's connection (role tools and file protection). */
  wrapTools: (tools: Tool[]) => Tool[];
  inactivityMs: number;
  startGraceMs: number;
  retryBaseDelayMs?: number;
  log?: (m: string) => void;
  /** Called for every notification from the worker session (resets the watchdog; feeds the UI). */
  onActivity?: (n: Record<string, any>) => void;
}

export type WorkerStatus = "ended" | "interrupted" | "timeout" | "error";
export interface WorkerOutcome {
  status: WorkerStatus;
  /** Why an interrupted run was interrupted. */
  interruptReason?: string;
  errorMessage?: string;
  /** reason of the final agent_turn_completed, when there was one. */
  turnReason?: string;
  text: string;
  messages: Message[];
  tokenUsage: TokenUsage;
}

export interface WorkerHandle {
  sessionId: string;
  done: Promise<WorkerOutcome>;
  /** Stop the worker; the outcome carries `reason`. */
  interrupt(reason: string): void;
}

export type WorkerSpawner = (req: WorkerRequest) => WorkerHandle;

/** Replaces long strings by a length marker (worker-transcripts.jsonl keeps skeletons, not content). */
export function skeleton(messages: Message[], max = 200): unknown[] {
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > max ? `[${v.length} chars]` : v;
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const blocks = (m.content as any[]).filter((b) => b.type === "text" || b.type === "tool_use")
      .map((b) => (b.type === "text" ? { type: "text", text: cut(b.text) } : { type: "tool_use", name: b.name, input: cut(b.input) }));
    out.push({ role: "assistant", content: blocks });
  }
  return out;
}

export const spawnWorkerSession: WorkerSpawner = (req) => {
  let reqN = 0;
  let text = "";
  let errorMessage: string | undefined;
  let interruptReason: string | undefined;
  let lastTurn: string | undefined;
  let finished = false;
  const waiters = new Map<string, (m: any) => void>();
  let turnDone!: () => void;
  const turned = new Promise<void>((r) => (turnDone = r));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let started = false;
  let stop!: (s: "timeout" | "interrupted") => void;
  const stopped = new Promise<"timeout" | "interrupted">((r) => (stop = r));

  const arm = () => {
    clearTimeout(timer);
    if (finished) return;
    timer = setTimeout(() => { timedOut = true; stop("timeout"); }, started ? req.inactivityMs : req.inactivityMs + req.startGraceMs);
  };

  const conn = createConnection((line) => {
    for (const l of line.split("\n")) {
      if (!l.trim()) continue;
      const m = JSON.parse(l);
      if (m.type === "response") { waiters.get(m.id)?.(m); continue; }
      const n = m.params?.notification;
      if (!n) continue;
      started = true;
      arm();
      req.onActivity?.(n);
      if (n.type === "assistant_text_delta") text += n.textDelta;
      else if (n.type === "error") errorMessage = n.message;
      else if (n.type === "agent_turn_completed") { lastTurn = n.reason; turnDone(); }
    }
  }, { canPrompt: false, log: req.log, retryBaseDelayMs: req.retryBaseDelayMs, wrapTools: req.wrapTools, forced: { autonomyLevel: "high", modelId: req.modelId } });

  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((res) => {
      const id = `mw-${++reqN}`;
      waiters.set(id, res);
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
    });

  const done = (async (): Promise<WorkerOutcome> => {
    const usageOf = () => conn.session?.tokenUsage ?? zeroUsage();
    const result = (status: WorkerStatus): WorkerOutcome => ({
      status, interruptReason, errorMessage, turnReason: lastTurn, text, messages: conn.session?.uiMessages() ?? [], tokenUsage: usageOf(),
    });
    try {
      arm();
      const init = req.resume
        ? await call("load_session", { sessionId: req.sessionId, cwd: req.cwd, autoRejectPermissionRequests: true })
        : await call("initialize_session", {
          machineId: "default", cwd: req.cwd, sessionId: req.sessionId, title: `Mission worker (${req.missionId})`,
          interactionMode: "auto", autonomyLevel: "high", autoRejectPermissionRequests: true, modelId: req.modelId,
          ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
        });
      if (init.error) { errorMessage = init.error.message; return result("error"); }
      const f = findSession(req.sessionId, req.cwd);
      if (f) updateSessionSettings(f, { tags: [{ name: "exec" }, { name: "mission", metadata: { role: req.role, missionId: req.missionId } }] });
      const added = await call("add_user_message", { text: req.prompt });
      if (added.error) { errorMessage = added.error.message; return result("error"); }
      const winner = await Promise.race([turned.then(() => "turn" as const), stopped]);
      if (winner === "turn") {
        return result(lastTurn === "completed" ? "ended" : lastTurn === "cancelled" ? "interrupted" : "error");
      }
      await call("interrupt_session", {});
      return result(winner);
    } catch (e) {
      errorMessage = (e as Error).message;
      return result("error");
    } finally {
      finished = true;
      clearTimeout(timer);
      try { await call("close_session", { reason: "other" }); } catch { /* closing */ }
      void conn.shutdown().catch(() => {});
    }
  })();

  return {
    sessionId: req.sessionId,
    done,
    interrupt(reason) { interruptReason = interruptReason ?? reason; stop("interrupted"); },
  };
};
