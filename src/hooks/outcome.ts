// Pure outcome parsing and per-event aggregation (spec §5.6 "Running" and "Outcomes by event").
// Results are checked in config order; the first match of each kind wins.

export interface HookJson {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
  };
}

/** One executed hook command. */
export interface HookResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timeout?: number;
  timedOut?: boolean;
  preserveRiskLevel?: boolean;
  /** Parsed JSON when stdout starts with `{` and parses; null otherwise. */
  json: HookJson | null;
  /** additionalContext, or plain non-JSON stdout, trimmed. Only set when exitCode is 0. */
  contextText: string;
  suppressOutput?: boolean;
}

export function parseStdout(stdout: string): HookJson | null {
  const t = stdout.trim();
  if (!t.startsWith("{")) return null;
  try {
    const j = JSON.parse(t);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as HookJson) : null;
  } catch { return null; }
}

export function makeResult(r: { command: string; exitCode: number; stdout: string; stderr: string; timeout?: number; timedOut?: boolean; preserveRiskLevel?: boolean }): HookResult {
  const json = parseStdout(r.stdout);
  let contextText = "";
  if (r.exitCode === 0) {
    contextText = json ? (json.hookSpecificOutput?.additionalContext ?? "").trim() : r.stdout.trim();
  }
  return { ...r, json, contextText, suppressOutput: json?.suppressOutput };
}

const joinText = (xs: string[]) => xs.filter(Boolean).join("\n");
const reasonOf = (r: HookResult) =>
  (r.json?.reason || r.json?.hookSpecificOutput?.permissionDecisionReason || r.stderr.trim() || r.json?.stopReason || r.json?.systemMessage || "").toString().trim();

/** Exit 3 anywhere: abort the whole agent turn; message = stderr. */
function abortOf(results: HookResult[]): { message: string } | null {
  const r = results.find((x) => x.exitCode === 3);
  return r ? { message: r.stderr.trim() || "aborted by hook" } : null;
}
function stopOf(results: HookResult[]): { reason: string } | null {
  const r = results.find((x) => x.json?.continue === false);
  return r ? { reason: r.json?.stopReason || r.json?.systemMessage || "stopped by hook" } : null;
}
const systemMessages = (results: HookResult[]) => results.map((r) => r.json?.systemMessage).filter((s): s is string => !!s);
const warnings = (results: HookResult[]) => results.filter((r) => r.exitCode === 1 && r.stderr.trim()).map((r) => r.stderr.trim());

// ---------------- PreToolUse ----------------
export interface PreToolUseOutcome {
  /** none: proceed to normal checks; allow: skip confirmation; deny: refuse the call; ask: normal confirmation;
   *  stop: end the turn (continue:false); abort: exit 3. */
  decision: "none" | "allow" | "deny" | "ask" | "stop" | "abort";
  /** deny/stop/abort reason or message (becomes the tool_result error text for deny). */
  reason?: string;
  /** Full replacement input = original merged with every hook's updatedInput (config order), when any hook set one. */
  updatedInput?: Record<string, unknown>;
  /** True when risk and policy checks must rerun on updatedInput (updatedInput set and decision is not allow). */
  rerunChecks: boolean;
  /** True when the hook that rewrote the input set preserveRiskLevel (keep original risk level). */
  preserveRiskLevel: boolean;
  additionalContext: string;
  systemMessages: string[];
  warnings: string[];
}

export function aggregatePreToolUse(results: HookResult[], originalInput: Record<string, unknown> = {}): PreToolUseOutcome {
  let updated: Record<string, unknown> | undefined;
  let preserve = false;
  for (const r of results) {
    const u = r.json?.hookSpecificOutput?.updatedInput;
    if (u && typeof u === "object" && !Array.isArray(u)) {
      updated = { ...(updated ?? originalInput), ...u };
      if (r.preserveRiskLevel) preserve = true;
    }
  }
  const base = {
    updatedInput: updated, preserveRiskLevel: preserve,
    additionalContext: joinText(results.map((r) => r.contextText)),
    systemMessages: systemMessages(results), warnings: warnings(results),
  };
  const mk = (decision: PreToolUseOutcome["decision"], reason?: string): PreToolUseOutcome =>
    ({ ...base, decision, reason, rerunChecks: !!updated && decision !== "allow" });
  const ab = abortOf(results);
  if (ab) return { ...mk("abort", ab.message), updatedInput: undefined, rerunChecks: false };
  const st = stopOf(results);
  if (st) return { ...mk("stop", st.reason), updatedInput: undefined, rerunChecks: false };
  const perm = (r: HookResult) => {
    const p = r.json?.hookSpecificOutput?.permissionDecision;
    if (p === "allow" || p === "deny" || p === "ask") return p;
    if (r.json?.decision === "block") return "deny";
    if (r.json?.decision === "approve") return "allow";
    return undefined;
  };
  // exit 2 and deny are both refusals; first in config order wins over any allow.
  for (const r of results) {
    if (r.exitCode === 2) return { ...mk("deny", r.stderr.trim() || "blocked by hook"), updatedInput: undefined, rerunChecks: false };
    if (perm(r) === "deny") return { ...mk("deny", reasonOf(r) || "blocked by hook"), updatedInput: undefined, rerunChecks: false };
  }
  if (results.some((r) => perm(r) === "allow")) return mk("allow");
  if (results.some((r) => perm(r) === "ask")) return mk("ask");
  return mk("none");
}

// ---------------- PostToolUse ----------------
export interface PostToolUseOutcome {
  abort?: string;
  stop?: string;
  /** Exit 2 stderr: feedback for the model (the tool result stands). */
  feedback: string;
  additionalContext: string;
  /** systemMessage values: shown to the user. */
  systemMessages: string[];
  warnings: string[];
}
export function aggregatePostToolUse(results: HookResult[]): PostToolUseOutcome {
  return {
    abort: abortOf(results)?.message, stop: stopOf(results)?.reason,
    feedback: joinText(results.filter((r) => r.exitCode === 2).map((r) => r.stderr.trim())),
    additionalContext: joinText(results.map((r) => r.contextText)),
    systemMessages: systemMessages(results), warnings: warnings(results),
  };
}

// ---------------- UserPromptSubmit ----------------
export interface UserPromptSubmitOutcome {
  blocked: boolean;
  /** Reason shown when blocked: reason, stderr, stopReason or systemMessage. */
  reason?: string;
  /** Replacement prompt (updatedInput.prompt), if any hook set one. */
  prompt?: string;
  additionalContext: string;
  systemMessages: string[];
}
export function aggregateUserPromptSubmit(results: HookResult[]): UserPromptSubmitOutcome {
  const b = results.find((r) => r.exitCode === 2 || r.exitCode === 3 || r.json?.continue === false || r.json?.decision === "block");
  let prompt: string | undefined;
  for (const r of results) {
    const p = r.json?.hookSpecificOutput?.updatedInput?.prompt;
    if (typeof p === "string") prompt = p;
  }
  return {
    blocked: !!b,
    reason: b ? (b.json?.reason || b.stderr.trim() || b.json?.stopReason || b.json?.systemMessage || "blocked by hook") : undefined,
    prompt: b ? undefined : prompt,
    additionalContext: joinText(results.map((r) => r.contextText)),
    systemMessages: systemMessages(results),
  };
}

// ---------------- Stop ----------------
export interface StopOutcome {
  abort?: string;
  /** continue:false: end the turn; value is stopReason. */
  stop?: string;
  /** decision:block + reason, or exit 2 + stderr: keep going with this text; set stop_hook_active on the next Stop. */
  continueWith?: string;
  systemMessages: string[];
}
export function aggregateStop(results: HookResult[]): StopOutcome {
  const out: StopOutcome = { systemMessages: systemMessages(results) };
  out.abort = abortOf(results)?.message;
  if (out.abort) return out;
  out.stop = stopOf(results)?.reason;
  if (out.stop) return out;
  const b = results.find((r) => r.exitCode === 2 || r.json?.decision === "block");
  if (b) out.continueWith = (b.exitCode === 2 ? b.stderr.trim() : (b.json?.reason ?? "").trim()) || (b.json?.reason ?? b.stderr.trim()) || "A stop hook asked you to continue.";
  return out;
}

// ---------------- SessionStart ----------------
export interface SessionStartOutcome { additionalContext: string; systemMessages: string[]; envVars: Record<string, string> }
export function aggregateSessionStart(results: HookResult[], envVars: Record<string, string> = {}): SessionStartOutcome {
  // Exit codes do not block here; context only comes from exit 0 (already enforced in makeResult).
  return { additionalContext: joinText(results.map((r) => r.contextText)), systemMessages: systemMessages(results), envVars };
}

// ---------------- PreCompact ----------------
export interface PreCompactOutcome { cancel: boolean; reason?: string }
/** Exit 2 or 3 cancels a manual compaction; automatic compaction cannot be blocked. */
export function aggregatePreCompact(results: HookResult[], trigger: "manual" | "auto"): PreCompactOutcome {
  if (trigger === "auto") return { cancel: false };
  const r = results.find((x) => x.exitCode === 2 || x.exitCode === 3);
  return r ? { cancel: true, reason: r.stderr.trim() || "cancelled by hook" } : { cancel: false };
}

/** Parse `export K=V` lines written to the env file (SessionStart). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
