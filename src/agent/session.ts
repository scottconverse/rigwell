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
import { DeferredRegistry, type DeferredState } from "./deferred.ts";
import { RequestBuilder } from "./request.ts";
import { contextBreakdown } from "./context-stats.ts";

export type WorkingState =
  | "idle" | "thinking" | "streaming_assistant_message" | "waiting_for_tool_confirmation" | "executing_tool";

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
  saveSettings(s: Record<string, unknown>): Promise<void>;
}

export interface SessionSettings {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  interactionMode: InteractionMode;
  autonomyLevel: AutonomyLevel;
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

  constructor(private deps: SessionDeps, private host: SessionHost) {
    this.id = deps.id;
    this.cwd = deps.cwd;
    this.settings = { ...deps.settings };
    this.messages = deps.messages ?? [];
    this.tokenUsage = deps.tokenUsage ?? zeroUsage();
    this.lastMode = this.effectiveMode();
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
    return { ...this.settings, toolExecutionMode: this.effectiveMode(), availableAutonomyLevels: ["off", "low", "medium", "high"] };
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

  async persistSettings() {
    await this.deps.persistence.saveSettings({
      model: this.settings.modelId, reasoningEffort: this.settings.reasoningEffort,
      interactionMode: this.settings.interactionMode, autonomyLevel: this.settings.autonomyLevel,
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

  private lastId(): string | null { return this.messages.at(-1)?.id ?? null; }

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

      for (;;) {
        if (signal.aborted) { reason = "cancelled"; break; }
        const model = this.deps.resolveModel(this.settings.modelId);
        if (!model) throw new ModelError("rejected", `Unknown model: ${this.settings.modelId}`);
        const messageId = crypto.randomUUID();
        const req = this.builder.build(this.buildInput(model, signal));
        this.setState("thinking");
        const partial = new Map<number, { id: string; name: string; json: string }>();
        const textBlocks = new Set<number>();
        let done: any;
        for await (const ev of this.deps.streamWithRetry(this.deps.createAdapter(model), req, {
          strategy: "non_interactive", baseDelayMs: this.deps.retryBaseDelayMs,
          onRetry: (attempt: number, why: string) => this.notify({ type: "llm_retry", attempt, reason: why }),
        })) {
          switch (ev.type) {
            case "text_delta":
              this.setState("streaming_assistant_message");
              textBlocks.add(ev.index);
              this.notify({ type: "assistant_text_delta", messageId, blockIndex: ev.index, textDelta: ev.text });
              break;
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
        for (const b of content) if (b.type === "tool_use") this.notify({ type: "tool_call", toolUse: { ...b } });
        this.notify({ type: "session_token_usage_changed", sessionId: this.id, tokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage });
        const texts = content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
        if (texts) lastText = texts;

        const calls = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (!calls.length) break;
        const outcome = await this.runTools(calls, signal);
        // Notices about tools loaded during this batch, and tools that appeared or went away, ride in the same message.
        const extra = [...this.deferred.takeNotices(), this.deferred.announcement()]
          .filter((t): t is string => !!t).map((text) => ({ type: "text" as const, text }));
        await this.push({ id: crypto.randomUUID(), role: "user", content: [...outcome.results, ...extra] });
        if (outcome.stop) { reason = outcome.stop; break; }
        if (await this.scriptWaitGuard(calls)) break;
      }
    } catch (e) {
      if (signal.aborted) reason = "cancelled";
      else {
        reason = reasonForError(e);
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

  private buildInput(model: ModelConfig, signal?: AbortSignal) {
    return {
      model, sessionId: this.id, mode: this.effectiveMode(), tools: this.tools(), messages: this.messages,
      reasoningEffort: this.settings.reasoningEffort, signal,
    };
  }

  /** get_context_stats extras: breakdown by category (estimated tokens) and the cache monitor numbers. */
  contextStats(limit: number) {
    const model = this.deps.resolveModel(this.settings.modelId);
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
    const model = this.deps.resolveModel(this.settings.modelId);
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
