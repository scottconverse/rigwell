// Hook runner: spawns commands, stdin JSON, timeouts, parallel groups, notifications (spec §5.6 Running).
import { killProcessTree, spawnShell } from "../platform/shell.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_HOOK_TIMEOUT_S, type HookCommand, type HookEventName, type HookGroup, type HooksConfig } from "./config.ts";
import { selectGroups } from "./match.ts";
import { makeResult, parseEnvFile, type HookResult } from "./outcome.ts";

export type PermissionModeName = "off" | "spec" | "auto-low" | "auto-medium" | "auto-high";

/** Fields every event's stdin carries. */
export interface HookBaseInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: PermissionModeName;
}

/** Payloads for `session_notification` (spec §3.1.7). */
export interface HookStartedNotification {
  type: "hook_execution_started";
  hookId: string;
  hookEventName: HookEventName;
  hookCommands: { command: string; timeout?: number }[];
  hookMatcher?: string;
  hookToolCallId?: string;
  hookParentId?: string;
  hookOrder?: number;
  isParallelExecution?: boolean;
  parallelGroupId?: string;
}
export interface HookCompletedNotification {
  type: "hook_execution_completed";
  hookId: string;
  hookStatus: "completed" | "error";
  hookEventName?: HookEventName;
  hookToolCallId?: string;
  hookPreventedAction?: boolean;
  hookResults?: { exitCode: number; stdout: string; stderr: string; command?: string; timeout?: number; suppressOutput?: boolean }[];
}
export type HookNotification = HookStartedNotification | HookCompletedNotification;

export interface RunCommandOptions {
  cwd: string;
  stdin: string;
  env?: Record<string, string>;
  timeoutS?: number;
  signal?: AbortSignal;
}

/** Run one shell command: `sh -c`, cwd, stdin JSON. Timeout: SIGTERM, counted as exit 1. Cancel: exit 1. */
export function runCommand(command: string, o: RunCommandOptions): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawnShell(command, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"], detached: !isWin });
    let stdout = "", stderr = "", done = false, timedOut = false, cancelled = false;
    const MAX = 1024 * 1024;
    child.stdout.on("data", (d) => { if (stdout.length < MAX) stdout += d.toString(); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX) stderr += d.toString(); });
    const killGroup = (sig: NodeJS.Signals) => {
      killProcessTree(child.pid, sig);
    };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hard); o.signal?.removeEventListener("abort", onAbort);
      const exitCode = timedOut || cancelled ? 1 : (code ?? 1);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); hardKill(); }, (o.timeoutS ?? DEFAULT_HOOK_TIMEOUT_S) * 1000);
    let hard: ReturnType<typeof setTimeout> | undefined;
    const hardKill = () => { hard = setTimeout(() => { killGroup("SIGKILL"); finish(null); }, 2000); };
    const onAbort = () => { cancelled = true; killGroup("SIGTERM"); hardKill(); };
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener("abort", onAbort); }
    child.on("error", (e) => { stderr += String(e); finish(1); });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => { /* hook ignored stdin */ });
    child.stdin.end(o.stdin);
  });
}

export interface RunHooksOptions {
  /** Matcher value: tool name (Pre/PostToolUse) or source (SessionStart). */
  matchValue?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolCallId?: string;
  parentId?: string;
  signal?: AbortSignal;
  notify?: (n: HookNotification) => void;
  /** Extra env vars for the commands. */
  env?: Record<string, string>;
  /** Called with a finished run so the caller can save it in the session transcript. */
  onRecord?: (rec: { hookId: string; event: HookEventName; results: HookResult[] }) => void;
}

export interface RunHooksResult {
  /** Flat results in config order (group order, then command order). Empty when nothing matched. */
  results: HookResult[];
  ran: boolean;
}

/**
 * Run every matching hook command for an event. All commands in all matching groups run in parallel;
 * results come back in config order. One started/completed notification pair per matching group.
 */
export async function runHooks(
  config: HooksConfig, event: HookEventName, base: HookBaseInput,
  extra: Record<string, unknown>, opts: RunHooksOptions = {},
): Promise<RunHooksResult> {
  if (config.hooksDisabled) return { results: [], ran: false };
  const groups = selectGroups(event, config.events[event], { value: opts.matchValue, toolName: opts.toolName, toolInput: opts.toolInput });
  if (!groups.length) return { results: [], ran: false };
  const stdin = JSON.stringify({ ...base, hook_event_name: event, ...extra });
  const parallelGroupId = randomUUID();
  const parallel = groups.length > 1 || groups.some((g) => g.hooks.length > 1);
  const env = {
    RIGWELL_PROJECT_DIR: base.cwd, CLAUDE_PROJECT_DIR: base.cwd, ...opts.env,
  };
  const perGroup = await Promise.all(groups.map(async (g, order) => {
    const hookId = randomUUID();
    opts.notify?.({
      type: "hook_execution_started", hookId, hookEventName: event,
      hookCommands: g.hooks.map((h) => ({ command: h.command, timeout: h.timeout })),
      hookMatcher: g.matcher, hookToolCallId: opts.toolCallId, hookParentId: opts.parentId,
      hookOrder: order, isParallelExecution: parallel, parallelGroupId,
    });
    const results = await Promise.all(g.hooks.map((h) => runOne(h, base.cwd, stdin, env, opts.signal)));
    const failed = results.some((r) => r.timedOut || (r.exitCode !== 0 && r.exitCode !== 1 && r.exitCode !== 2 && r.exitCode !== 3));
    opts.notify?.({
      type: "hook_execution_completed", hookId, hookStatus: failed ? "error" : "completed",
      hookEventName: event, hookToolCallId: opts.toolCallId,
      hookPreventedAction: results.some((r) => r.exitCode === 2 || r.exitCode === 3 || r.json?.continue === false),
      hookResults: results.map((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, command: r.command, timeout: r.timeout, suppressOutput: r.suppressOutput })),
    });
    opts.onRecord?.({ hookId, event, results });
    return results;
  }));
  return { results: perGroup.flat(), ran: true };
}

async function runOne(h: HookCommand, cwd: string, stdin: string, env: Record<string, string>, signal?: AbortSignal): Promise<HookResult> {
  const r = await runCommand(h.command, { cwd, stdin, env, timeoutS: h.timeout, signal });
  return makeResult({ command: h.command, ...r, timeout: h.timeout, preserveRiskLevel: h.preserveRiskLevel });
}

// ------------------------------------------------------------------ SessionStart env file

/** Run SessionStart hooks with a CLAUDE_ENV_FILE; returns results plus the env vars the hooks exported. */
export async function runSessionStartHooks(
  config: HooksConfig, base: HookBaseInput, source: "startup" | "resume" | "compact" | string,
  extra: Record<string, unknown> = {}, opts: RunHooksOptions = {},
): Promise<RunHooksResult & { envVars: Record<string, string> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "rigwell-hookenv-"));
  const envFile = path.join(dir, "env.sh");
  try {
    const r = await runHooks(config, "SessionStart", base, { source, CLAUDE_ENV_FILE: envFile, ...extra },
      { ...opts, matchValue: source, env: { CLAUDE_ENV_FILE: envFile, RIGWELL_ENV_FILE: envFile, ...opts.env } });
    let envVars: Record<string, string> = {};
    try { envVars = parseEnvFile(readFileSync(envFile, "utf8")); } catch { /* none written */ }
    return { ...r, envVars };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export type { HookGroup };
