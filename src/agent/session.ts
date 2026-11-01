// One agent session: holds the transcript, runs turns, emits notifications (spec §3.1.7, §4).
import { basename } from "node:path";
import type {
  AutonomyLevel, CommandLists, ContentBlock, InteractionMode, Message, ModelAdapter, ModelConfig,
  PermissionDecision, ReasoningEffort, TokenUsage, Tool, ToolResultBlock, ToolUseBlock, FileReadRecord,
} from "../core/types.ts";
import type { ToolExecutionMode, ToolOutput } from "../core/types.ts";
import { ModelError, zeroUsage } from "../core/types.ts";
import { JobManager, type Job } from "../jobs/manager.ts";
import { ToolCallError } from "../script/bindings.ts";
import { ScriptService, type ScriptLimits } from "../script/service.ts";
import { contextBlocks, guardText } from "./prompts.ts";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";
import { DEFAULT_GUARDS, RepeatTracker, detectCycle, resolveGuards, type Cycle, type GuardConfig, type GuardSettings } from "./guards.ts";
import {
  buildSummarizerRequest, collectSummary, contextTextBlocks, messagesTokens, pickCut, preambleBlocks, preambleMessage,
  resolveCompaction, type CompactionConfig,
} from "./compaction.ts";
import { AUTO_MODEL_ID, route, type RouteChoice, type RouterConfig } from "./router.ts";
import type { CompactionRecord } from "../storage/transcript.ts";
import { DeferredRegistry, type DeferredState } from "./deferred.ts";
import { RequestBuilder } from "./request.ts";
import { contextBreakdown } from "./context-stats.ts";
import { estimateTokens } from "./budget.ts";

export type WorkingState =
  | "idle" | "thinking" | "streaming_assistant_message" | "waiting_for_tool_confirmation" | "executing_tool"
  | "compacting_conversation";

/** The model's answer was one block repeating (spec 4.2): the turn ends with an error naming the cycle. */
export class OutputCycleError extends Error {
  constructor(public cycle: Cycle) {
    super(`the same ${cycle.length}-character block repeated ${cycle.repeats} times in the model output.`);
    this.name = "OutputCycleError";
  }
}

/** compact_session while a turn is running. */
export class SessionBusyError extends Error {
  constructor() { super("A turn is running; wait for it to finish or interrupt it before compacting."); this.name = "SessionBusyError"; }
}

export type TurnReason =
  | "completed" | "cancelled" | "permission_rejected" | "error" | "no_approver_available"
  | "model_authentication_failed" | "model_request_rejected" | "model_provider_unreachable"
  | "model_provider_unavailable" | "model_rate_limited";

export interface PermissionAnswer { selectedOption: string; comment?: string }

/** What a session needs from the connection that owns it. */
export interface SessionHost {
  notify(n: Record<string, unknown>): void;
  /** Present only when a client can answer prompts (stream-jsonrpc). */
  requestPermission?: (params: Record<string, unknown>) => Promise<PermissionAnswer>;
}

/** Persistence hooks, implemented over src/storage. */
export interface SessionPersistence {
  appendMessage(msg: Message, parentId: string | null): Promise<void>;
  appendTurnOutcome(o: { turnId: string; reason: string; resultKind: "text" | null }): Promise<void>;
  appendCompaction?(rec: CompactionRecord): Promise<void>;
  saveSettings(s: Record<string, unknown>): Promise<void>;
}

export interface SessionSettings {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  interactionMode: InteractionMode;
  autonomyLevel: AutonomyLevel;
  /** Model that writes compaction summaries (default: the session model). */
  compactionModelId?: string;
}

export interface SessionDeps {
  id: string;
  cwd: string;
  settings: SessionSettings;
  resolveModel: (id: string) => ModelConfig | undefined;
  createAdapter: (m: ModelConfig) => ModelAdapter;
  streamWithRetry: (a: ModelAdapter, req: any, opts: any) => AsyncIterable<any>;
  toolsFor: (o: { autonomy: AutonomyLevel; skipPermissions: boolean }) => Tool[];
  decide: (tool: string, input: Record<string, unknown>, ctx: any) => PermissionDecision;
  lists: CommandLists;
  skipPermissions: boolean;
  autoRejectPermissionRequests: boolean;
  persistence: SessionPersistence;
  shell: string;
  retryBaseDelayMs?: number;
  /** Models (ids or API names) that run script_only; every other model runs direct_only (spec §4.1). */
  scriptToolModels?: string[];
  /** Per-session override from initialize_session. */
  toolExecutionModeOverride?: ToolExecutionMode;
  scriptLimits?: ScriptLimits;
  /** Restored state (load_session). */
  messages?: Message[];
  tokenUsage?: TokenUsage;
  /** Deferred tools loaded and announced before this session was saved (spec §6.2, §12.1). */
  deferred?: Partial<DeferredState>;
  /** Log sink (cache monitor, guards). */
  log?: (m: string) => void;
  /** Loop guard thresholds (llmRequestTimeout, loopGuards) from settings. */
  guardSettings?: GuardSettings;
  /** Compaction numbers (reserve, target, headroom, caps) and the automatic trigger. */
  compaction?: Partial<CompactionConfig>;
  compactionTokenLimit?: number;
  compactionThresholdCheckEnabled?: boolean;
  /** Candidates for the "auto" model id (spec 4.5). */
  router?: RouterConfig;
  /** Restored from a compaction_state record: messages before the anchor (UI only) and the anchor's id. */
  archived?: Message[];
  compactionAnchorId?: string;
}

/** Waits on one running Script before the turn is stopped (2 hours of 5-minute waits). */
export const SCRIPT_WAIT_STOP = 24;

function modeNotice(mode: ToolExecutionMode): string {
  return mode === "script_only"
    ? "<system-reminder>The model changed. From now on you reach tools only through Script (tools.Name({...}) inside a program, as the Script description shows), plus script_job for background jobs. The direct tools are no longer sent.</system-reminder>"
    : "<system-reminder>The model changed. From now on the tools (Read, Execute, Grep, Glob, Edit, Create) are available to call directly. Script and script_job are still available.</system-reminder>";
}

const AUTONOMY_RANK: Record<AutonomyLevel, number> = { off: 0, low: 1, medium: 2, high: 3 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

export function reasonForError(e: unknown): TurnReason {
  if (!(e instanceof ModelError)) return "error";
  switch (e.kind) {
    case "auth": return "model_authentication_failed";
    case "rate_limited": return "model_rate_limited";
    case "rejected": return "model_request_rejected";
    case "network": case "timeout": return "model_provider_unreachable";
    case "unavailable": case "overloaded": return "model_provider_unavailable";
    default: return "error";
  }
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  settings: SessionSettings;
  messages: Message[];
  tokenUsage: TokenUsage;
  lastCallTokenUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  workingState: WorkingState = "idle";
  providerLock?: string;
  private readFiles = new Map<string, FileReadRecord>();
  private queue: { text: string; messageId: string }[] = [];
  private running = false;
  private abort?: AbortController;
  private activeTimeMs = 0;
  private currentRun?: Promise<void>;
  readonly jobs = new JobManager();
  private scripts: ScriptService;
  /** Notices to append before the next user message (e.g. the tool mode changed with the model). */
  private pendingNotices: string[] = [];
  private lastMode: ToolExecutionMode;
  private waitStreak = { jobId: "", count: 0 };
  /** Set by an inner Script call whose permission was refused in a way that ends the turn. */
  private pendingStop?: TurnReason;
  /** Deferred tools (MCP and others): announced by name, loaded with load_tools. */
  readonly deferred: DeferredRegistry;
  /** Builds every request and runs the cache monitor (spec §6). */
  readonly builder: RequestBuilder;
  /** Messages replaced by a compaction summary: kept for the UI, never sent to the model. */
  archived: Message[];
  private compactionAnchor?: string;
  private compactedOnce = false;
  private callsSinceCompaction = 0;
  /** Context size after the last model call (tokens) and the message count it covered. */
  private lastCallContext?: { tokens: number; count: number };
  /** The model "auto" routing picked for the latest request. */
  private routed?: RouteChoice;

  constructor(private deps: SessionDeps, private host: SessionHost) {
    this.id = deps.id;
    this.cwd = deps.cwd;
    this.settings = { ...deps.settings };
    this.messages = deps.messages ?? [];
    this.tokenUsage = deps.tokenUsage ?? zeroUsage();
    this.lastMode = this.effectiveMode();
    this.archived = deps.archived ?? [];
    this.compactionAnchor = deps.compactionAnchorId;
    this.compactedOnce = !!deps.compactionAnchorId;
    this.deferred = new DeferredRegistry(deps.deferred);
    this.builder = new RequestBuilder(deps.log);
    this.scripts = new ScriptService({
      sessionId: this.id, jobs: this.jobs, limits: deps.scriptLimits,
      toolNames: () => this.scriptTools().map((t) => t.name),
      host: {
        cwd: this.cwd,
        callTool: (name, input, meta) => this.callInner(name, input, meta),
        notify: (text) => this.notify({ type: "tool_progress_update", toolUseId: "script", toolName: "Script", update: { type: "status", text, timestamp: new Date().toISOString() } }),
      },
    });
    this.jobs.onFinished(() => { if (!this.running) this.kick(); });
  }

  /** Effective tool mode: the per-session override, else the model allowlist (spec §4.1). */
  effectiveMode(modelId: string = this.settings.modelId): ToolExecutionMode {
    if (this.deps.toolExecutionModeOverride) return this.deps.toolExecutionModeOverride;
    const list = this.deps.scriptToolModels ?? [];
    const apiName = this.deps.resolveModel(modelId)?.model;
    return list.includes(modelId) || (apiName !== undefined && list.includes(apiName)) ? "script_only" : "direct_only";
  }

  /** Tools Script and direct calls can reach (autonomy gates apply). */
  private coreTools(): Tool[] {
    return this.deps.toolsFor({ autonomy: this.settings.autonomyLevel, skipPermissions: this.deps.skipPermissions });
  }

  /** Core tools plus ToolSearch and load_tools: what a Script binds (loaded deferred tools bind by name on call). */
  private scriptTools(): Tool[] {
    return [...this.coreTools(), this.deferred.toolSearchTool(), this.deferred.loadToolsTool()];
  }

  /** Makes a tool deferred: announced by name, schema sent only after load_tools. MCP tools register through here. */
  registerDeferredTool(tool: Tool) { this.deferred.register(tool); }
  unregisterDeferredTool(name: string) { this.deferred.unregister(name); }

  get isRunning() { return this.running; }

  /**
   * Tools sent to the model: Script and script_job always; the core tools, load_tools and call_tool too in
   * direct_only. Loading a deferred tool never changes this list (spec §6.2).
   */
  tools(): Tool[] {
    const core = this.coreTools();
    const script = [this.scripts.scriptTool(), this.scripts.jobTool()];
    return this.effectiveMode() === "script_only" ? script : [...core, this.deferred.loadToolsTool(), this.deferred.callToolTool(), ...script];
  }

  private notify(n: Record<string, unknown>) { this.host.notify(n); }

  private setState(s: WorkingState) {
    if (this.workingState === s) return;
    this.workingState = s;
    this.notify({ type: "agent_working_state_changed", newState: s });
  }

  settingsSnapshot(): Record<string, unknown> {
    return {
      ...this.settings, toolExecutionMode: this.effectiveMode(), availableAutonomyLevels: ["off", "low", "medium", "high"],
      ...(this.routed ? { effectiveRouterModel: this.routedSettings() } : {}),
    };
  }

  updateSettings(p: Partial<SessionSettings>) {
    const causes: string[] = [];
    if (p.modelId !== undefined && p.modelId !== this.settings.modelId) causes.push("model changed");
    if (p.autonomyLevel !== undefined && p.autonomyLevel !== this.settings.autonomyLevel) causes.push("autonomy changed (tool list)");
    if (causes.length) this.builder.monitor.expectBreak(causes.join(", "));
    Object.assign(this.settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    const mode = this.effectiveMode();
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.pendingNotices.push(modeNotice(mode));
    }
    this.notify({ type: "settings_updated", settings: this.settingsSnapshot() });
    void this.persistSettings();
  }

  private routedSettings() {
    const r = this.routed!;
    const eff = this.settings.reasoningEffort;
    return { modelId: r.modelId, reasoningEffort: eff, reason: r.reason, fallbacks: r.fallbacks.map((f) => ({ modelId: f, reasoningEffort: eff })) };
  }

  /** Everything the UI shows: messages replaced by a summary, then the live history. */
  uiMessages(): Message[] { return [...this.archived, ...this.messages]; }

  async persistSettings() {
    await this.deps.persistence.saveSettings({
      model: this.settings.modelId, reasoningEffort: this.settings.reasoningEffort,
      interactionMode: this.settings.interactionMode, autonomyLevel: this.settings.autonomyLevel,
      ...(this.settings.compactionModelId ? { compactionModelId: this.settings.compactionModelId } : {}),
      effectiveRouterModel: this.routed ? this.routedSettings() : undefined,
      toolExecutionMode: this.effectiveMode(),
      ...(this.deps.toolExecutionModeOverride ? { toolExecutionModeOverride: this.deps.toolExecutionModeOverride } : {}),
      assistantActiveTimeMs: this.activeTimeMs,
      tokenUsage: this.tokenUsage, inclusiveTokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage,
      ...(this.providerLock ? { providerLock: this.providerLock, apiProviderLock: this.providerLock } : {}),
      loadedDeferredToolNames: this.deferred.state().loaded, announcedDeferredToolNames: this.deferred.state().announced,
    });
  }

  /** Accepts a user message. Returns at once; the turn runs in the background. */
  addUserMessage(text: string, messageId: string = crypto.randomUUID()) {
    this.queue.push({ text, messageId });
    this.kick();
  }

  /** Starts the turn loop unless it is already running. */
  private kick() {
    if (this.currentRun) return;
    const p = this.drain();
    this.currentRun = p;
    void p.then(() => { if (this.currentRun === p) this.currentRun = undefined; });
  }

  /** Resolves when no turn is running. */
  async idle() { while (this.currentRun) await this.currentRun; }

  interrupt() { this.abort?.abort(); }

  private async drain() {
    this.running = true;
    try {
      for (;;) {
        while (this.queue.length) {
          const next = this.queue.shift()!;
          await this.runTurn(next.text, next.messageId);
        }
        // A background job finished while the model was asleep: wake it with a reminder (spec §4.3).
        const wake = this.takeWake();
        if (!wake) break;
        await this.runTurn(wake, `wake-${crypto.randomUUID()}`, "llm_only");
      }
    } finally {
      this.running = false;
    }
  }

  /** Reminder text for background jobs that finished unseen, or null. Marks them seen. */
  private takeWake(): string | null {
    const done = this.jobs.unreported();
    if (!done.length) return null;
    const parts = done.map((j) => {
      j.reported = true;
      let body = JSON.stringify(j.report());
      if (body.length > 16_000) body = `${body.slice(0, 8_000)} ... [cut] ... ${body.slice(-8_000)}`;
      return `Background job ${j.id} (${j.kind}) finished with status ${j.status}. Result:\n${body}`;
    });
    return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
  }

  /** True while background jobs run or finished results have not reached the model. */
  hasBackgroundWork(): boolean {
    return this.jobs.running().length > 0 || this.jobs.unreported().length > 0;
  }

  /** Resolves when no turn runs and no background work is left (jobs finish, the wake turn runs). */
  async settled() {
    for (;;) {
      await this.idle();
      if (!this.hasBackgroundWork()) return;
      const live = this.jobs.running();
      if (!live.length) { this.kick(); continue; }
      await Promise.race(live.map((j) => j.done));
      await Promise.resolve();
    }
  }

  async stopBackgroundJobs() { await this.jobs.stopAll(); }

  private lastId(): string | null {
    const last = this.messages.at(-1);
    // The preamble after a compaction is not a transcript message: chain from the message the summary ends at.
    if (last?.id.startsWith("context-compact-")) return this.compactionAnchor ?? null;
    return last?.id ?? null;
  }

  private async push(msg: Message) {
    const parent = this.lastId();
    this.messages.push(msg);
    await this.deps.persistence.appendMessage(msg, parent);
  }

  private async runTurn(text: string, turnId: string, visibility?: "llm_only") {
    const started = Date.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let turnUsage = zeroUsage();
    let reason: TurnReason = "completed";
    let lastText = "";

    try {
      if (!this.messages.some((m) => m.role === "user")) {
        const ctx = contextBlocks({
          cwd: this.cwd, interactionMode: this.settings.interactionMode, autonomy: this.settings.autonomyLevel,
          modelId: this.settings.modelId, shell: this.deps.shell, toolExecutionMode: this.effectiveMode(),
        });
        await this.push({ id: `context-${turnId}`, role: "user", visibility: "llm_only", content: ctx.map((t) => ({ type: "text", text: t })) });
      }
      for (const n of this.pendingNotices.splice(0)) {
        await this.push({ id: `notice-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: n }] });
      }
      for (const n of [...this.deferred.takeNotices(), this.deferred.announcement()]) {
        if (n) await this.push({ id: `deferred-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: n }] });
      }
      await this.push({ id: turnId, role: "user", ...(visibility ? { visibility } : {}), content: [{ type: "text", text }] });

      const repeat = new RepeatTracker();
      let emptyStreak = 0;
      for (;;) {
        if (signal.aborted) { reason = "cancelled"; break; }
        await this.maybeAutoCompact(signal);
        const messageId = crypto.randomUUID();
        const { model, done } = await this.callWithFallbacks(messageId, signal);
        // The final message is the source of truth; deltas were display only (a retried stream may have repeated them).
        const content: ContentBlock[] = done.content;
        this.builder.monitor.recordUsage(done.usage);
        turnUsage = addUsage(turnUsage, done.usage);
        this.tokenUsage = addUsage(this.tokenUsage, done.usage);
        this.lastCallTokenUsage = { inputTokens: done.usage.inputTokens, cacheReadTokens: done.usage.cacheReadTokens, outputTokens: done.usage.outputTokens };
        this.providerLock ??= model.provider;
        await this.push({
          id: messageId, role: "assistant", content, modelId: model.id, apiProvider: model.provider,
          reasoningEffort: this.settings.reasoningEffort, ...(done.openaiReasoning?.length ? { openaiReasoning: done.openaiReasoning } : {}),
        });
        this.lastCallContext = {
          tokens: done.usage.inputTokens + done.usage.cacheReadTokens + done.usage.cacheCreationTokens + done.usage.outputTokens,
          count: this.messages.length,
        };
        this.callsSinceCompaction++;
        for (const b of content) if (b.type === "tool_use") this.notify({ type: "tool_call", toolUse: { ...b } });
        this.notify({ type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage });
        const texts = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
        if (texts) lastText = texts;

        const calls = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (!calls.length && texts.trim() === "") {
          // No visible output (empty or thinking only): a one-word nudge each time, stop after emptyTurnStop in a row (spec 4.2).
          emptyStreak++;
          if (emptyStreak >= this.guards().emptyTurnStop) {
            await this.guardStop("guard_empty_stop_user", "guard_empty_stop_transcript", { COUNT: emptyStreak });
            break;
          }
          await this.push({ id: `nudge-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText("guard_empty_nudge") }] });
          continue;
        }
        emptyStreak = 0;
        if (!calls.length) break;

        const outcome = await this.runTools(calls, signal);
        // Notices about tools loaded during this batch, and tools that appeared or went away, ride in the same message.
        const extra = [...this.deferred.takeNotices(), this.deferred.announcement()]
          .filter((t): t is string => !!t).map((text) => ({ type: "text" as const, text }));
        // Repeated identical batches with unchanged results: nudge, then stop (waits on a running Script have their own guard).
        const names = [...new Set(calls.map((c) => c.name))].join(", ");
        const isWait = calls.some((c) => c.name === "script_job" && c.input.action === "wait");
        const n = isWait ? (repeat.reset(), 0) : repeat.record(calls, outcome.results.map((r) => r.content));
        const g = this.guards();
        const vars = { TOOL_NAMES: names, COUNT: n, PLURAL: calls.length > 1 };
        if (n === g.repeatNudgeAt) extra.push({ type: "text", text: guardText("guard_repeat_nudge", vars) });
        await this.push({ id: crypto.randomUUID(), role: "user", content: [...outcome.results, ...extra] });
        if (outcome.stop) { reason = outcome.stop; break; }
        if (n >= g.repeatStopAt) {
          await this.guardStop("guard_repeat_stop_user", "guard_repeat_stop_transcript", vars);
          break;
        }
        if (await this.scriptWaitGuard(calls)) break;
      }
    } catch (e) {
      if (signal.aborted) reason = "cancelled";
      else {
        reason = e instanceof OutputCycleError ? "error" : reasonForError(e);
        if (e instanceof OutputCycleError) {
          await this.push({ id: `cycle-${crypto.randomUUID()}`, role: "user", visibility: "llm_only", content: [{ type: "text", text: `[Your previous response was cut by the harness: ${e.message} Do not repeat it; answer differently or ask the user.]` }] });
        }
        this.notify({
          type: "error", message: String((e as Error)?.message ?? e), errorType: "SessionError",
          timestamp: new Date().toISOString(), error: { name: (e as Error)?.name ?? "Error", message: String((e as Error)?.message ?? e) },
        });
      }
    }

    const durationMs = Date.now() - started;
    this.activeTimeMs += durationMs;
    this.notify({ type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage });
    await this.deps.persistence.appendTurnOutcome({ turnId, reason, resultKind: lastText ? "text" : null });
    await this.persistSettings();
    this.notify({ type: "agent_turn_completed", reason, turnId, tokenUsage: turnUsage, cumulativeTokenUsage: this.tokenUsage, durationMs });
    this.setState("idle");
    this.abort = undefined;
  }

  private guards(model?: ModelConfig): GuardConfig {
    return resolveGuards(this.deps.guardSettings, model ?? this.currentModel());
  }

  /** The model a request would go to now: the session model, or for "auto" the routed pick (else the first candidate). */
  private currentModel(): ModelConfig | undefined {
    const id = this.settings.modelId;
    if (id === AUTO_MODEL_ID && this.deps.router) {
      return this.deps.resolveModel(this.routed?.modelId ?? this.deps.router.candidates[0]?.model ?? "");
    }
    return this.deps.resolveModel(id);
  }

  /** The user-facing stop notice and the transcript text for the next turn (spec prompts.md section 7). */
  private async guardStop(userKey: keyof typeof PROMPT_TEXT, transcriptKey: keyof typeof PROMPT_TEXT, vars: Record<string, unknown>) {
    const notice: Message = { id: crypto.randomUUID(), role: "assistant", visibility: "user_only", content: [{ type: "text", text: guardText(userKey, vars) }] };
    await this.push(notice);
    this.notify({ type: "create_message", message: notice });
    await this.push({ id: crypto.randomUUID(), role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText(transcriptKey, vars) }] });
  }

  // ---------- model choice (auto routing, spec 4.5) ----------

  private async chooseModels(signal: AbortSignal): Promise<{ primary: ModelConfig; fallbacks: ModelConfig[] }> {
    const id = this.settings.modelId;
    if (id === AUTO_MODEL_ID && this.deps.router) {
      const choice = await route(this.deps.router, this.messages, {
        resolveModel: this.deps.resolveModel,
        stream: (m, r) => this.deps.streamWithRetry(this.deps.createAdapter(m), r, { strategy: "no_retry" }),
      }, signal);
      const primary = this.deps.resolveModel(choice.modelId);
      if (!primary) throw new ModelError("rejected", `Auto routing picked an unknown model: ${choice.modelId}`);
      const changed = this.routed?.modelId !== choice.modelId;
      this.routed = choice;
      this.deps.log?.(`[router] ${choice.modelId} (${choice.reason}); scores ${JSON.stringify(choice.scores)}; fallbacks ${choice.fallbacks.join(", ") || "none"}`);
      if (changed) { this.notify({ type: "settings_updated", settings: this.settingsSnapshot() }); void this.persistSettings(); }
      return { primary, fallbacks: choice.fallbacks.map((f) => this.deps.resolveModel(f)).filter((m): m is ModelConfig => !!m) };
    }
    const model = this.deps.resolveModel(id);
    if (!model) throw new ModelError("rejected", `Unknown model: ${id}`);
    return { primary: model, fallbacks: [] };
  }

  /** Streams one answer from the chosen model; when the provider fails for good, the next fallback (routing only). */
  private async callWithFallbacks(messageId: string, signal: AbortSignal): Promise<{ model: ModelConfig; done: any }> {
    const { primary, fallbacks } = await this.chooseModels(signal);
    const order = [primary, ...fallbacks];
    for (let i = 0; i < order.length; i++) {
      const model = order[i]!;
      if (i > 0) this.builder.monitor.expectBreak(`router fallback to ${model.id}`);
      try {
        return { model, done: await this.streamOnce(model, messageId, signal) };
      } catch (e) {
        if (signal.aborted || !(e instanceof ModelError) || i === order.length - 1) throw e;
        this.deps.log?.(`[router] ${model.id} failed (${e.message}); trying ${order[i + 1]!.id}`);
      }
    }
    throw new ModelError("unknown", "no model could be called");
  }

  private async streamOnce(model: ModelConfig, messageId: string, signal: AbortSignal): Promise<any> {
    const g = this.guards(model);
    const req = { ...this.builder.build(this.buildInput(model, signal)), limits: { idleTimeoutMs: g.streamIdleTimeoutMs, hardLimitMs: g.hardResponseLimitMs } };
    this.setState("thinking");
    let partial = new Map<number, { id: string; name: string; json: string }>();
    let textBlocks = new Set<number>();
    let streamText = "";
    let checked = 0;
    let done: any;
    for await (const ev of this.deps.streamWithRetry(this.deps.createAdapter(model), req, {
      strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs, passEmpty: true,
      onRetry: (attempt: number, why: string) => {
        // A retried stream starts over: what the failed attempt streamed is discarded (spec 4.2).
        partial = new Map(); textBlocks = new Set(); streamText = ""; checked = 0;
        this.notify({ type: "llm_retry", attempt, reason: why });
      },
    })) {
      switch (ev.type) {
        case "text_delta": {
          this.setState("streaming_assistant_message");
          textBlocks.add(ev.index);
          this.notify({ type: "assistant_text_delta", messageId, blockIndex: ev.index, textDelta: ev.text });
          streamText += ev.text;
          if (streamText.length - checked >= 400) {
            checked = streamText.length;
            const c = detectCycle(streamText, g.cycleMinChars, g.cycleMinRepeats);
            if (c) throw new OutputCycleError(c);
          }
          break;
        }
        case "thinking_delta":
          this.notify({ type: "thinking_text_delta", messageId, blockIndex: ev.index, textDelta: ev.text });
          break;
        case "tool_use_start":
          this.setState("streaming_assistant_message");
          partial.set(ev.index, { id: ev.id, name: ev.name, json: "" });
          this.notify({ type: "tool_call", toolUse: { type: "tool_use", id: ev.id, name: ev.name, input: {} } });
          break;
        case "tool_input_delta": {
          const p = partial.get(ev.index);
          if (p) {
            p.json += ev.partialJson;
            try {
              this.notify({ type: "tool_call", toolUse: { type: "tool_use", id: p.id, name: p.name, input: JSON.parse(p.json) } });
            } catch { /* partial JSON: wait for more */ }
          }
          break;
        }
        case "block_stop":
          if (textBlocks.has(ev.index)) this.notify({ type: "assistant_text_complete", messageId, blockIndex: ev.index });
          break;
        case "message_done":
          done = ev;
          break;
      }
    }
    if (!done) throw new ModelError("empty_response", "model stream ended without a final message");
    return done;
  }

  // ---------- compaction (spec 4.4) ----------

  private compactionCfg(): CompactionConfig { return resolveCompaction(this.deps.compaction); }

  /** Tokens at which automatic compaction starts: compactionTokenLimit, else the model's window minus the summary reserve. */
  compactionThreshold(): number {
    if (this.deps.compactionTokenLimit) return this.deps.compactionTokenLimit;
    return (this.currentModel()?.maxContextLimit ?? 200_000) - this.compactionCfg().reserveTokens;
  }

  /** Size of the next request: the last reported call plus what was added since; else an estimate of the whole prefix. */
  estimateContextTokens(): number {
    if (this.lastCallContext && this.lastCallContext.count <= this.messages.length) {
      return this.lastCallContext.tokens + messagesTokens(this.messages.slice(this.lastCallContext.count));
    }
    const model = this.currentModel();
    if (!model) return messagesTokens(this.messages);
    return Object.values(contextBreakdown(this.builder.preview(this.buildInput(model)))).reduce((a, b) => a + b, 0);
  }

  private async maybeAutoCompact(signal: AbortSignal): Promise<void> {
    if (this.deps.compactionThresholdCheckEnabled === false) return;
    if (this.compactedOnce && this.callsSinceCompaction < this.guards().minCallsBetweenCompactions) return;
    if (this.estimateContextTokens() < this.compactionThreshold()) return;
    await this.compact({ reason: "automatic", signal });
  }

  /** compact_session: compacts in place (the session id stays), so newSessionId is this session's id. */
  async compactManual(o: { customInstructions?: string; mode?: "handoff" }): Promise<{ newSessionId: string; removedCount: number }> {
    if (this.running) throw new SessionBusyError();
    this.running = true;
    this.abort = new AbortController();
    try {
      const r = await this.compact({ reason: "manual", customInstructions: o.customInstructions, mode: o.mode, signal: this.abort.signal });
      return { newSessionId: this.id, removedCount: r.removedCount };
    } finally {
      this.abort = undefined;
      this.running = false;
      if (this.queue.length) this.kick();
    }
  }

  private compactionModel(): ModelConfig {
    const id = this.settings.compactionModelId;
    const m = (id && this.deps.resolveModel(id)) || this.currentModel();
    if (!m) throw new ModelError("rejected", `Unknown model: ${this.settings.modelId}`);
    return m;
  }

  /**
   * Summarizes the old part of the conversation and replaces it with the preamble message. The system prompt and tool
   * list are not touched; the loaded deferred tools are re-announced and recorded; the routed model is cleared.
   */
  async compact(o: { reason: "automatic" | "manual"; customInstructions?: string; mode?: "handoff"; signal?: AbortSignal }): Promise<{ removedCount: number }> {
    const cfg = this.compactionCfg();
    const before = this.workingState;
    this.setState("compacting_conversation");
    try {
      const context = contextTextBlocks(this.messages);
      const reinject = this.deferred.reinjection();
      const fixed = messagesTokens([preambleMessage("x", [...context, ...(reinject ? [reinject] : [])])]);
      const keepBudget = Math.max(0, cfg.postCeilingTokens - cfg.targetTokens - fixed);
      const cut = o.mode === "handoff" ? this.messages.length : pickCut(this.messages, keepBudget, cfg.keepRecentTurns);
      const removed = this.messages.slice(0, cut);
      const real = removed.filter((m) => !m.id.startsWith("context-compact-"));
      if (!real.length) throw new Error("Nothing to compact yet.");
      const model = this.compactionModel();
      const g = this.guards(model);
      const built = buildSummarizerRequest({
        model, sessionId: this.id, messages: removed, cfg, customInstructions: o.customInstructions,
        limits: { idleTimeoutMs: g.streamIdleTimeoutMs, hardLimitMs: g.hardResponseLimitMs },
      });
      this.deps.log?.(`[compaction] ${o.reason}: summarizing ${real.length} messages (${built.transcriptChars} chars) with ${model.id}; summarizer limit ${built.limit} tokens, max_tokens ${built.req.maxOutputTokens}`);
      const stream = this.deps.streamWithRetry(this.deps.createAdapter(model), { ...built.req, signal: o.signal }, {
        strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs,
        onRetry: (attempt: number, why: string) => this.notify({ type: "llm_retry", attempt, reason: why }),
      });
      const { text, usage } = await collectSummary(stream);
      if (!text) throw new ModelError("empty_response", "The summarizer returned no text.");
      if (usage) {
        this.tokenUsage = addUsage(this.tokenUsage, usage);
        this.notify({ type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage });
      }

      const anchor = real.at(-1)!;
      const anchorIndex = this.archived.length + this.messages.indexOf(anchor) - (this.messages[0]?.id.startsWith("context-compact-") ? 1 : 0);
      const blocks = preambleBlocks(text, context, reinject ? [reinject] : []);
      const preambleId = `context-compact-${crypto.randomUUID()}`;
      const record: CompactionRecord = {
        type: "compaction_state", id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        summaryText: text, summaryTokens: estimateTokens(text.length), summaryKind: "llm_summary",
        anchorMessage: { id: anchor.id, index: anchorIndex }, removedCount: real.length,
        loadedDeferredToolNames: this.deferred.loadedNames(), retainedSkills: [], retainedImages: [],
        reason: o.reason, preambleMessageId: preambleId, preambleBlocks: blocks,
      };
      await this.deps.persistence.appendCompaction?.(record);
      this.archived.push(...real);
      this.messages = [preambleMessage(preambleId, blocks), ...this.messages.slice(cut)];
      this.compactionAnchor = anchor.id;
      this.lastCallContext = undefined;
      this.routed = undefined; // the routed pick is cleared: routing runs again (spec 4.5)
      this.callsSinceCompaction = 0;
      this.compactedOnce = true;
      this.builder.monitor.expectBreak("compaction");
      this.notify({ type: "session_compacted", summaryId: record.id, removedCount: real.length, visibleBoundaryMessageId: this.messages[1]?.id ?? null });
      await this.persistSettings();
      return { removedCount: real.length };
    } finally {
      this.setState(before === "compacting_conversation" ? "idle" : before);
    }
  }

  private buildInput(model: ModelConfig, signal?: AbortSignal) {
    return {
      model, sessionId: this.id, mode: this.effectiveMode(), tools: this.tools(), messages: this.messages,
      reasoningEffort: this.settings.reasoningEffort, signal,
    };
  }

  /** get_context_stats extras: breakdown by category (estimated tokens) and the cache monitor numbers. */
  contextStats(limit: number) {
    const model = this.currentModel();
    const used = this.lastCallTokenUsage.inputTokens + this.lastCallTokenUsage.cacheReadTokens + this.lastCallTokenUsage.outputTokens;
    const breakdown = model ? contextBreakdown(this.builder.preview(this.buildInput(model))) : undefined;
    const estimated = breakdown ? Object.values(breakdown).reduce((a, b) => a + b, 0) : 0;
    const now = used || estimated;
    return {
      used: now, remaining: Math.max(0, limit - now), limit, accuracy: used ? "exact" : "estimated",
      updatedAt: new Date().toISOString(),
      ...(breakdown ? { breakdown, breakdownAccuracy: "estimated" } : {}),
      cache: this.builder.monitor.stats(),
    };
  }

  /** warmup_cache: sends a priming request for the current prefix. Best effort; never throws. */
  async warmupCache(): Promise<void> {
    if (this.running) return;
    const model = this.currentModel();
    if (!model) return;
    try {
      const input = this.buildInput(model);
      const req = this.builder.buildWarmup(input);
      if (!req.messages.length) {
        req.messages = [{ id: "warmup", role: "user", content: [{ type: "text", text: "<system-reminder>Cache warm-up. Reply with one word.</system-reminder>" }] }];
      }
      for await (const ev of this.deps.streamWithRetry(this.deps.createAdapter(model), req, { strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs })) {
        if (ev.type === "message_done") {
          this.tokenUsage = addUsage(this.tokenUsage, ev.usage);
          this.deps.log?.(`[cache] warmup: read ${ev.usage.cacheReadTokens}, created ${ev.usage.cacheCreationTokens}, uncached ${ev.usage.inputTokens}`);
        }
      }
      this.notify({ type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage });
    } catch (e) {
      this.deps.log?.(`[cache] warmup failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private async runTools(calls: ToolUseBlock[], signal: AbortSignal): Promise<{ results: ToolResultBlock[]; stop?: TurnReason }> {
    const results: ToolResultBlock[] = [];
    let stop: TurnReason | undefined;
    const tools = new Map(this.tools().map((t) => [t.name, t]));
    for (const call of calls) {
      const phase = (p: string) => this.notify({ type: "tool_execution_phase_changed", toolUseId: call.id, toolName: call.name, phase: p });
      const finish = (content: string, isError: boolean, executed: boolean) => {
        results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
        this.notify({ type: "tool_result", toolUseId: call.id, messageId: `tool-result-${call.id}`, content, isError });
        phase(executed ? "settled_after_execution" : "settled_without_execution");
      };
      phase("queued");
      if (stop || signal.aborted) { finish("Not run: the turn was stopped before this call.", true, false); continue; }
      const tool = tools.get(call.name);
      if (!tool) { finish(`Unknown tool: ${call.name}. Use one of: ${[...tools.keys()].join(", ")}.`, true, false); continue; }

      const d = this.gate(call.name, call.input);
      if (d.decision === "block" || d.decision === "missing_risk") { finish(d.message, true, false); continue; }
      if (d.decision === "ask") {
        const verdict = await this.askPermission(call, d);
        if (verdict === "rejected") { finish("The user rejected this tool call. Do not retry it; change your approach or ask the user.", true, false); continue; }
        if (verdict === "cancel") { finish("The user rejected this tool call and stopped the turn.", true, false); stop = "permission_rejected"; continue; }
        if (verdict === "no_approver") {
          finish("This call needs approval, and this run cannot ask for it.", true, false);
          stop = "no_approver_available";
          this.notify({
            type: "error", errorType: "SessionError", timestamp: new Date().toISOString(),
            message: `Tool call ${call.name} needs approval at autonomy "${this.settings.autonomyLevel}". Re-run with a higher --auto level (low, medium, high) or with --skip-permissions-unsafe.`,
          });
          continue;
        }
      }
      phase("executing");
      this.setState("executing_tool");
      try {
        const out = await tool.run(call.input, {
          cwd: this.cwd, sessionId: this.id, readFiles: this.readFiles, signal, toolUseId: call.id, jobs: this.jobs,
          onProgress: (p) => this.notify({ type: "tool_progress_update", toolUseId: call.id, toolName: call.name, update: { ...p, timestamp: new Date().toISOString() } }),
        });
        finish(out.content, !!out.isError, true);
      } catch (e) {
        finish(`Tool failed: ${(e as Error)?.message ?? e}`, true, true);
      }
      if (this.pendingStop) { stop = this.pendingStop; this.pendingStop = undefined; }
    }
    return { results, stop };
  }

  /** Permission decision for one call. Deferred tools (MCP and others) ask unless they only read; call_tool is judged by its target. */
  private gate(name: string, input: Record<string, unknown>): PermissionDecision {
    let target: Tool | undefined;
    let args = input;
    if (name === "call_tool") {
      const r = this.deferred.resolveCallable(String(input.name ?? ""));
      if (typeof r === "string") return { decision: "allow" }; // the tool call itself returns the error text
      target = r;
      args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>;
    } else if (!this.scriptTools().some((t) => t.name === name) && this.deferred.get(name)) {
      target = this.deferred.get(name);
    }
    if (target) {
      if (this.deps.skipPermissions || target.category === "read") return { decision: "allow" };
      return {
        decision: "ask", confirmationType: "exec", impactLevel: "high", alwaysLevel: null,
        details: { toolName: target.name, input: args }, reason: `Deferred tool ${target.name}`,
      };
    }
    return this.deps.decide(name, input, {
      autonomy: this.settings.autonomyLevel, interactionMode: this.settings.interactionMode,
      skipPermissions: this.deps.skipPermissions, lists: this.deps.lists, cwd: this.cwd,
    });
  }

  /**
   * One tool call made from inside a Script. It takes the same path as a direct call: permission
   * gate (a prompt per call that needs one), execution, notifications and transcript records.
   * Throws ToolCallError when the call is refused; the Script sees a rejected promise.
   */
  private async callInner(
    name: string, input: Record<string, unknown>,
    meta: { runId: string; n: number; outerId: string; signal: AbortSignal; foreground: boolean },
  ): Promise<ToolOutput> {
    const id = `${meta.runId}-${meta.n}`;
    const use: ToolUseBlock = { type: "tool_use", id, name, input, scriptExecution: { runId: meta.runId, outerToolUseId: meta.outerId } };
    this.notify({ type: "tool_call", toolUse: use });
    await this.push({ id: `repl-tool-call:${id}`, role: "assistant", visibility: "user_only", content: [use] });
    const finish = async (content: string, isError: boolean) => {
      this.notify({ type: "tool_result", toolUseId: id, messageId: `repl-tool-result:${id}`, content, isError });
      await this.push({ id: `repl-tool-result:${id}`, role: "user", visibility: "user_only", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] });
    };
    const refuse = async (message: string, errName = "Error"): Promise<never> => {
      await finish(message, true);
      throw new ToolCallError(message, errName);
    };
    let tool = this.scriptTools().find((t) => t.name === name);
    if (!tool) {
      // A deferred tool: callable once loaded (tools.server.tool is the name server__tool).
      if (!this.deferred.get(name) && !this.deferred.isLoaded(name)) {
        return refuse(`Unknown tool: ${name}. Available in a Script: ${this.scriptTools().map((t) => t.name).join(", ")}, plus deferred tools after tools.load_tools.`);
      }
      const r = this.deferred.resolveCallable(name);
      if (typeof r === "string") return refuse(r);
      tool = r;
    }
    if (name === "Execute" && input.background === true) {
      return refuse("background is not available inside a Script. Start the whole Script with //@background instead.");
    }
    const d = this.gate(name, input);
    if (d.decision === "block") return refuse(d.message, "PermissionDenied");
    if (d.decision === "missing_risk") return refuse(d.message);
    if (d.decision === "ask") {
      const verdict = await this.askPermission(use, d);
      if (verdict === "rejected") return refuse("PermissionDenied: the user rejected this tool call. Do not retry it; change your approach or ask the user.", "PermissionDenied");
      if (verdict === "cancel" || verdict === "no_approver") {
        if (meta.foreground && this.abort && !this.abort.signal.aborted) {
          this.pendingStop = verdict === "cancel" ? "permission_rejected" : "no_approver_available";
          if (verdict === "no_approver") {
            this.notify({
              type: "error", errorType: "SessionError", timestamp: new Date().toISOString(),
              message: `Tool call ${name} (inside a Script) needs approval at autonomy "${this.settings.autonomyLevel}". Re-run with a higher --auto level (low, medium, high) or with --skip-permissions-unsafe.`,
            });
          }
          this.abort.abort();
        }
        return refuse(verdict === "cancel"
          ? "PermissionDenied: the user rejected this tool call and stopped the turn."
          : "PermissionDenied: this call needs approval, and this run cannot ask for it.", "PermissionDenied");
      }
    }
    try {
      const out = await tool.run(input, { cwd: this.cwd, sessionId: this.id, readFiles: this.readFiles, signal: meta.signal, toolUseId: id });
      await finish(out.content, !!out.isError);
      return out;
    } catch (e) {
      return refuse(`Tool failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Spec §4.2: repeats that are only waits on one running Script get no nudge and stop at 24.
   * Returns true when the turn was stopped.
   */
  private async scriptWaitGuard(calls: ToolUseBlock[]): Promise<boolean> {
    const first = calls[0];
    const jobId = first?.name === "script_job" && first.input.action === "wait" ? String(first.input.job_id ?? "") : "";
    const onlyWaits = jobId !== "" && calls.every((c) => c.name === "script_job" && c.input.action === "wait" && c.input.job_id === jobId);
    if (!onlyWaits || this.jobs.get(jobId)?.status !== "running") { this.waitStreak = { jobId: "", count: 0 }; return false; }
    this.waitStreak = this.waitStreak.jobId === jobId ? { jobId, count: this.waitStreak.count + 1 } : { jobId, count: 1 };
    if (this.waitStreak.count < SCRIPT_WAIT_STOP) return false;
    const vars = { JOB_ID: jobId, COUNT: this.waitStreak.count, HOURS: Math.round((this.waitStreak.count * 5) / 60) };
    this.waitStreak = { jobId: "", count: 0 };
    const user = guardText("guard_scriptwait_stop_user", vars);
    const notice: Message = { id: crypto.randomUUID(), role: "assistant", visibility: "user_only", content: [{ type: "text", text: user }] };
    await this.push(notice);
    this.notify({ type: "create_message", message: notice });
    await this.push({ id: crypto.randomUUID(), role: "user", visibility: "llm_only", content: [{ type: "text", text: guardText("guard_scriptwait_stop_transcript", vars) }] });
    return true;
  }

  /** Returns "approved", "rejected" (model continues), "cancel" (turn stops) or "no_approver". */
  private async askPermission(call: ToolUseBlock, d: Extract<PermissionDecision, { decision: "ask" }>) {
    if (this.deps.autoRejectPermissionRequests) return "rejected" as const;
    if (!this.host.requestPermission) return "no_approver" as const;
    const options = [{ label: "Yes, allow once", value: "proceed_once" }];
    if (d.alwaysLevel) options.push({ label: `Yes, and always allow ${d.alwaysLevel}`, value: "proceed_always" });
    options.push({ label: "No, cancel", value: "cancel" });
    this.setState("waiting_for_tool_confirmation");
    const requestId = crypto.randomUUID();
    let ans: PermissionAnswer;
    try {
      ans = await this.host.requestPermission({
        requestId,
        toolUses: [{ toolUse: { type: "tool_use", id: call.id, name: call.name, input: call.input }, confirmationType: d.confirmationType, details: { ...d.details, ...(d.reason ? { riskLevelReason: d.details.riskLevelReason ?? d.reason } : {}) } }],
        options,
      });
    } catch {
      ans = { selectedOption: "cancel" };
    }
    const valid = options.some((o) => o.value === ans?.selectedOption) ? ans.selectedOption : "cancel";
    this.notify({ type: "permission_resolved", requestId, toolUseIds: [call.id], selectedOption: valid });
    if (valid === "proceed_always" && d.alwaysLevel && AUTONOMY_RANK[d.alwaysLevel] > AUTONOMY_RANK[this.settings.autonomyLevel]) {
      this.updateSettings({ autonomyLevel: d.alwaysLevel });
    }
    return valid === "cancel" ? ("cancel" as const) : ("approved" as const);
  }
}

export const fileName = (p: string) => basename(p);
