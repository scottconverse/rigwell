// Hooks (spec §5.6). Standalone module; the lead wires it into the loop.
//
// Integration (in Session / the tool loop):
//   - Construct once per session: `const hooks = new HookRunner({ config: loadHooksConfig({cwd}), sessionId,
//     transcriptPath, cwd, permissionMode: () => ..., notify: (n) => this.notify(n) })`. `notify` payloads are the
//     `hook_execution_started` / `hook_execution_completed` session_notification bodies (spec §3.1.7, already shaped).
//   - SessionStart: `await hooks.sessionStart("startup"|"resume"|"compact")` before the first turn (wait up to 60 s;
//     the runner does not itself apply the 60 s cap, pass `AbortSignal.timeout(60000)` if desired). Add
//     `.additionalContext` as context before the first turn; export `.envVars` into the Execute tool env.
//   - UserPromptSubmit: `hooks.userPromptSubmit(prompt, messageId, hasImages)` when add_user_message arrives. If
//     `.blocked` do not start the turn and show `.reason`; if `.prompt` replace the prompt; append `.additionalContext`.
//   - PreToolUse: call `hooks.preToolUse(toolName, input, toolUseId)` BEFORE decide() (permission gate), for direct
//     calls AND for calls made inside Script (a deny/stop becomes a script-side "rejected by policy" error).
//     Outcome: decision "deny" => tool_result isError with `.reason`; "stop" => end the turn with `.reason`;
//     "abort" => abort the agent (turn reason error, message `.reason`); "allow" => skip confirmation (use
//     `.updatedInput` if present); "ask"/"none" => normal flow; `.rerunChecks` => recompute risk/policy on
//     `.updatedInput` (keep the original risk level when `.preserveRiskLevel`). Append `.additionalContext` to the model.
//   - PostToolUse: `hooks.postToolUse(toolName, input, response, toolUseId)` after a tool finishes (skip when
//     cancelled; fires once for the outer Script call, not for inner calls). `.feedback` => extra text to the model;
//     `.additionalContext` => model; `.systemMessages` => user; `.stop` ends the turn; `.abort` aborts.
//   - Stop: when the model ends a turn with no tool calls: `hooks.stop({messageId, toolExecutionCount, elapsedMs})`.
//     `.continueWith` => append it as a user-side message and run another iteration (runner tracks stop_hook_active
//     itself; call `hooks.resetStop()` at the start of each user turn). `.stop`/`.abort` end the turn.
//     If the user interrupted, call `hooks.notification("idle_prompt", ...)` instead of stop.
//   - SubagentStop / Notification: fire-and-forget (`hooks.subagentStop`, `hooks.notification`).
//   - PreCompact: `hooks.preCompact("manual"|"auto", ...)`; `.cancel` aborts a manual compaction only.
//   - SessionEnd: `await hooks.sessionEnd(reason, durationMs, messageCount)` on close_session before exit.
export * from "./config.ts";
export * from "./match.ts";
export * from "./outcome.ts";
export { runHooks, runCommand, runSessionStartHooks } from "./runner.ts";
export type { HookBaseInput, HookNotification, HookStartedNotification, HookCompletedNotification, PermissionModeName, RunHooksOptions, RunHooksResult } from "./runner.ts";

import type { HooksConfig } from "./config.ts";
import {
  aggregatePostToolUse, aggregatePreCompact, aggregatePreToolUse, aggregateSessionStart, aggregateStop,
  aggregateUserPromptSubmit,
} from "./outcome.ts";
import { runHooks, runSessionStartHooks, type HookNotification, type PermissionModeName } from "./runner.ts";

export interface HookRunnerOptions {
  config: HooksConfig;
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  permissionMode: () => PermissionModeName;
  notify?: (n: HookNotification) => void;
  /** Extra variables for every hook command (a session environment). */
  env?: Record<string, string>;
}

export class HookRunner {
  private stopActive = false;
  constructor(private o: HookRunnerOptions) {}

  get config(): HooksConfig { return this.o.config; }
  /** True when at least one hook is configured (lets the loop skip all hook plumbing). */
  hasHooks(): boolean { return !this.o.config.hooksDisabled && Object.keys(this.o.config.events).length > 0; }
  resetStop() { this.stopActive = false; }

  private base() {
    return { session_id: this.o.sessionId, transcript_path: this.o.transcriptPath, cwd: this.o.cwd, permission_mode: this.o.permissionMode() };
  }
  private opts(extra: object = {}) { return { notify: this.o.notify, ...(this.o.env ? { env: this.o.env } : {}), ...extra }; }

  async preToolUse(toolName: string, toolInput: Record<string, unknown>, toolCallId?: string, signal?: AbortSignal) {
    const r = await runHooks(this.o.config, "PreToolUse", this.base(), { tool_name: toolName, tool_input: toolInput },
      this.opts({ matchValue: toolName, toolName, toolInput, toolCallId, signal }));
    return aggregatePreToolUse(r.results, toolInput);
  }
  async postToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, toolCallId?: string, signal?: AbortSignal) {
    const r = await runHooks(this.o.config, "PostToolUse", this.base(),
      { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse },
      this.opts({ matchValue: toolName, toolName, toolInput, toolCallId, signal }));
    return aggregatePostToolUse(r.results);
  }
  async userPromptSubmit(prompt: string, messageId?: string, hasImages = false, signal?: AbortSignal) {
    const r = await runHooks(this.o.config, "UserPromptSubmit", this.base(), { message_id: messageId, prompt, has_images: hasImages }, this.opts({ signal }));
    return aggregateUserPromptSubmit(r.results);
  }
  async stop(a: { messageId?: string; toolExecutionCount: number; elapsedMs: number }, signal?: AbortSignal) {
    const r = await runHooks(this.o.config, "Stop", this.base(),
      { message_id: a.messageId, stop_hook_active: this.stopActive, tool_execution_count: a.toolExecutionCount, elapsed_time: a.elapsedMs },
      this.opts({ signal }));
    const out = aggregateStop(r.results);
    if (out.continueWith) this.stopActive = true;
    return out;
  }
  async sessionStart(source: "startup" | "resume" | "compact", extra: Record<string, unknown> = {}, signal?: AbortSignal) {
    const r = await runSessionStartHooks(this.o.config, this.base(), source, extra, this.opts({ signal }));
    return aggregateSessionStart(r.results, r.envVars);
  }
  async sessionEnd(reason: string, sessionDurationMs: number, messageCount: number, messageId?: string) {
    await runHooks(this.o.config, "SessionEnd", this.base(),
      { reason, session_duration_ms: sessionDurationMs, message_count: messageCount, message_id: messageId }, this.opts());
  }
  async preCompact(trigger: "manual" | "auto", a: { customInstructions?: string; messageCount: number; estimatedTokens: number; messageId?: string }) {
    const r = await runHooks(this.o.config, "PreCompact", this.base(),
      { trigger, custom_instructions: a.customInstructions, message_count: a.messageCount, estimated_tokens: a.estimatedTokens, message_id: a.messageId }, this.opts());
    return aggregatePreCompact(r.results, trigger);
  }
  /** Fire-and-forget; results ignored. */
  notification(notificationType: "permission_prompt" | "idle_prompt" | "elicitation_dialog", message: string, messageId?: string): Promise<void> {
    return runHooks(this.o.config, "Notification", this.base(), { message_id: messageId, message, notification_type: notificationType }, this.opts()).then(() => {}, () => {});
  }
  subagentStop(taskName: string, taskResult: string, taskError?: string): Promise<void> {
    return runHooks(this.o.config, "SubagentStop", this.base(),
      { task_name: taskName, task_result: taskResult, task_error: taskError, stop_hook_active: false }, this.opts()).then(() => {}, () => {});
  }
}
