// One agent session: holds the transcript, runs turns, emits notifications (spec §3.1.7, §4).
import { basename } from "node:path";
import type {
  AutonomyLevel, CommandLists, ContentBlock, InteractionMode, Message, ModelAdapter, ModelConfig,
  PermissionDecision, ReasoningEffort, TokenUsage, Tool, ToolResultBlock, ToolUseBlock, FileReadRecord,
} from "../core/types.ts";
import { ModelError, zeroUsage } from "../core/types.ts";
import { contextBlocks, systemBlocks } from "./prompts.ts";

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
  /** Restored state (load_session). */
  messages?: Message[];
  tokenUsage?: TokenUsage;
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

  constructor(private deps: SessionDeps, private host: SessionHost) {
    this.id = deps.id;
    this.cwd = deps.cwd;
    this.settings = { ...deps.settings };
    this.messages = deps.messages ?? [];
    this.tokenUsage = deps.tokenUsage ?? zeroUsage();
  }

  get isRunning() { return this.running; }

  tools(): Tool[] {
    return this.deps.toolsFor({ autonomy: this.settings.autonomyLevel, skipPermissions: this.deps.skipPermissions });
  }

  private notify(n: Record<string, unknown>) { this.host.notify(n); }

  private setState(s: WorkingState) {
    if (this.workingState === s) return;
    this.workingState = s;
    this.notify({ type: "agent_working_state_changed", newState: s });
  }

  settingsSnapshot(): Record<string, unknown> {
    return { ...this.settings, toolExecutionMode: "direct_only", availableAutonomyLevels: ["off", "low", "medium", "high"] };
  }

  updateSettings(p: Partial<SessionSettings>) {
    Object.assign(this.settings, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    this.notify({ type: "settings_updated", settings: this.settingsSnapshot() });
    void this.persistSettings();
  }

  async persistSettings() {
    await this.deps.persistence.saveSettings({
      model: this.settings.modelId, reasoningEffort: this.settings.reasoningEffort,
      interactionMode: this.settings.interactionMode, autonomyLevel: this.settings.autonomyLevel,
      toolExecutionMode: "direct_only", assistantActiveTimeMs: this.activeTimeMs,
      tokenUsage: this.tokenUsage, inclusiveTokenUsage: this.tokenUsage, lastCallTokenUsage: this.lastCallTokenUsage,
      ...(this.providerLock ? { providerLock: this.providerLock, apiProviderLock: this.providerLock } : {}),
    });
  }

  /** Accepts a user message. Returns at once; the turn runs in the background. */
  addUserMessage(text: string, messageId: string = crypto.randomUUID()) {
    this.queue.push({ text, messageId });
    if (!this.running) this.currentRun = this.drain();
  }

  /** Resolves when no turn is running. */
  async idle() { while (this.currentRun) await this.currentRun; }

  interrupt() { this.abort?.abort(); }

  private async drain() {
    this.running = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        await this.runTurn(next.text, next.messageId);
      }
    } finally {
      this.running = false;
      this.currentRun = undefined;
    }
  }

  private lastId(): string | null { return this.messages.at(-1)?.id ?? null; }

  private async push(msg: Message) {
    const parent = this.lastId();
    this.messages.push(msg);
    await this.deps.persistence.appendMessage(msg, parent);
  }

  private async runTurn(text: string, turnId: string) {
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
          modelId: this.settings.modelId, shell: this.deps.shell,
        });
        await this.push({ id: `context-${turnId}`, role: "user", visibility: "llm_only", content: ctx.map((t) => ({ type: "text", text: t })) });
      }
      await this.push({ id: turnId, role: "user", content: [{ type: "text", text }] });

      for (;;) {
        if (signal.aborted) { reason = "cancelled"; break; }
        const model = this.deps.resolveModel(this.settings.modelId);
        if (!model) throw new ModelError("rejected", `Unknown model: ${this.settings.modelId}`);
        const messageId = crypto.randomUUID();
        const tools = this.tools();
        const req = {
          model, sessionId: this.id, system: systemBlocks(),
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          messages: this.modelMessages(model.provider),
          maxOutputTokens: model.maxOutputTokens ?? 32000,
          reasoningEffort: this.settings.reasoningEffort, signal,
        };
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
        await this.push({ id: crypto.randomUUID(), role: "user", content: outcome.results });
        if (outcome.stop) { reason = outcome.stop; break; }
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

  /** Messages the model sees, in order. Encrypted reasoning is dropped when the provider changed. */
  private modelMessages(provider: string): Message[] {
    return this.messages
      .filter((m) => m.visibility !== "user_only")
      .map((m) => (m.openaiReasoning && m.apiProvider !== provider ? { ...m, openaiReasoning: undefined } : m));
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

      const d = this.deps.decide(call.name, call.input, {
        autonomy: this.settings.autonomyLevel, interactionMode: this.settings.interactionMode,
        skipPermissions: this.deps.skipPermissions, lists: this.deps.lists, cwd: this.cwd,
      });
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
          cwd: this.cwd, sessionId: this.id, readFiles: this.readFiles, signal,
          onProgress: (p) => this.notify({ type: "tool_progress_update", toolUseId: call.id, toolName: call.name, update: { ...p, timestamp: new Date().toISOString() } }),
        });
        finish(out.content, !!out.isError, true);
      } catch (e) {
        finish(`Tool failed: ${(e as Error)?.message ?? e}`, true, true);
      }
    }
    return { results, stop };
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
