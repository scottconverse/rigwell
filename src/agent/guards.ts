// Loop guards (spec §4.2). The rules live in the loop, not the prompt; every threshold is a config value.
import type { ModelConfig, ToolUseBlock } from "../core/types.ts";

export interface GuardConfig {
  /** Stream silent this long: dropped and retried. 240 s for the vendor's hosted Anthropic stream, else llmRequestTimeout. */
  streamIdleTimeoutMs: number;
  /** One response may take this long (hard time limit); only the first cut is retried. */
  hardResponseLimitMs: number;
  /** Responses with no visible output in a row before the turn stops. */
  emptyTurnStop: number;
  /** Same batch of tool calls with the same results: nudge at this count, stop at the next. */
  repeatNudgeAt: number;
  repeatStopAt: number;
  /** Output cycle: the tail of the answer is one block repeated at least this many times, over at least this many characters. */
  cycleMinRepeats: number;
  cycleMinChars: number;
  /** Model calls that must pass after a compaction before an automatic one may run again. */
  minCallsBetweenCompactions: number;
}

export const VENDOR_ANTHROPIC_IDLE_MS = 240_000;
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 600_000;

export const DEFAULT_GUARDS = {
  emptyTurnStop: 3,
  repeatNudgeAt: 3,
  repeatStopAt: 6,
  cycleMinRepeats: 8,
  cycleMinChars: 1_200,
  minCallsBetweenCompactions: 2,
} as const;

/** Settings shape (user settings.json): `llmRequestTimeout` (ms) and `loopGuards`. */
export interface GuardSettings {
  llmRequestTimeout?: number;
  loopGuards?: Partial<GuardConfig>;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** True when the model talks to the vendor's own Anthropic endpoint. */
export function isVendorHostedAnthropic(m: ModelConfig): boolean {
  if (m.provider !== "anthropic") return false;
  try { return new URL(m.baseUrl).hostname === "api.anthropic.com"; } catch { return false; }
}

export function resolveGuards(s: GuardSettings | undefined, model?: ModelConfig): GuardConfig {
  const o = s?.loopGuards ?? {};
  const requestTimeout = posInt(s?.llmRequestTimeout) ? s!.llmRequestTimeout! : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const idle = posInt(o.streamIdleTimeoutMs)
    ? o.streamIdleTimeoutMs
    : model && isVendorHostedAnthropic(model) ? VENDOR_ANTHROPIC_IDLE_MS : requestTimeout;
  const pick = <K extends keyof typeof DEFAULT_GUARDS>(k: K): number => (posInt(o[k]) ? (o[k] as number) : DEFAULT_GUARDS[k]);
  return {
    streamIdleTimeoutMs: idle,
    hardResponseLimitMs: posInt(o.hardResponseLimitMs) ? o.hardResponseLimitMs : requestTimeout,
    emptyTurnStop: pick("emptyTurnStop"), repeatNudgeAt: pick("repeatNudgeAt"), repeatStopAt: pick("repeatStopAt"),
    cycleMinRepeats: pick("cycleMinRepeats"), cycleMinChars: pick("cycleMinChars"),
    minCallsBetweenCompactions: pick("minCallsBetweenCompactions"),
  };
}

// ---------- repeated identical tool calls ----------

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Drops values that differ on every run without meaning anything (ids, durations), so a repeated call compares equal. */
function stable(result: string): string {
  return result
    .replace(/\b(scr|job)_[0-9a-f]{12}\b/g, "$1_*")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "*")
    .replace(/"(durationMs|duration_ms|elapsedMs)":\s*\d+/g, '"$1":0');
}

/** Counts consecutive batches with the same calls (names + arguments) AND the same results. New results reset the count. */
export class RepeatTracker {
  private key = "";
  count = 0;

  /** Records one finished batch. Returns the number of identical batches in a row, this one included. */
  record(calls: ToolUseBlock[], results: string[]): number {
    const k = canonical(calls.map((c) => [c.name, c.input])) + "|" + canonical(results.map(stable));
    this.count = k === this.key ? this.count + 1 : 1;
    this.key = k;
    return this.count;
  }

  reset() { this.key = ""; this.count = 0; }
}

// ---------- output cycles ----------

/** Smallest period of `s` (length minus the longest border), by the KMP prefix function. */
function smallestPeriod(s: string): number {
  const f = new Int32Array(s.length);
  for (let i = 1, k = 0; i < s.length; i++) {
    while (k > 0 && s[i] !== s[k]) k = f[k - 1]!;
    if (s[i] === s[k]) k++;
    f[i] = k;
  }
  return s.length - f[s.length - 1]!;
}

export interface Cycle { length: number; repeats: number }

/**
 * Looks at the tail of streamed text for one block repeating: the last W characters (W = min chars, then doubled up to
 * 8x) are periodic with period p, and W / p reaches the repeat threshold. Call it every few hundred characters.
 */
export function detectCycle(text: string, minChars: number, minRepeats: number): Cycle | null {
  for (let w = minChars; w <= minChars * 8; w *= 2) {
    if (text.length < w) break;
    const tail = text.slice(-w);
    const p = smallestPeriod(tail);
    if (p <= w / minRepeats) return { length: p, repeats: Math.floor(w / p) };
  }
  return null;
}
