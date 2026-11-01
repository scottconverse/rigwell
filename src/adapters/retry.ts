import { ModelError, type ModelAdapter, type ModelRequest, type StreamEvent } from "../core/types.ts";

export type RetryReason = "overloaded" | "rate_limited" | "timeout" | "network" | "empty_response" | "unknown";

export interface RetryOptions {
  strategy?: "non_interactive" | "interactive" | "no_retry";
  /** Overrides the strategy's base delay (tests). */
  baseDelayMs?: number;
  /** `attempt` is the 1-based number of the attempt that just failed. */
  onRetry?: (attempt: number, reason: RetryReason, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const PROFILES = {
  non_interactive: { attempts: 5, rateLimitAttempts: 5, base: 2000, mult: 2.5 },
  interactive: { attempts: 4, rateLimitAttempts: 6, base: 1000, mult: 2 },
  no_retry: { attempts: 1, rateLimitAttempts: 1, base: 0, mult: 1 },
} as const;

function reasonOf(e: ModelError): RetryReason {
  switch (e.kind) {
    case "overloaded": case "unavailable": return "overloaded";
    case "rate_limited": return "rate_limited";
    case "timeout": return "timeout";
    case "network": return "network";
    case "empty_response": return "empty_response";
    default: return "unknown";
  }
}

/**
 * Streams `adapter.stream(req)` with retries (spec §4.6.9).
 *
 * Events are yielded live (no buffering). If an attempt fails after it already yielded
 * deltas, the next attempt starts over: its block indexes begin at 0 again and its deltas
 * repeat the answer from the start. Therefore CONSUMERS MUST treat `message_done.content`
 * as the only source of truth and use deltas for display only; partial output of a failed
 * attempt is never part of the final message (spec §4.2). A UI may clear its live preview
 * when the `onRetry` callback fires.
 *
 * An empty response (message_done with no content blocks) is retried once.
 */
export async function* streamWithRetry(
  adapter: ModelAdapter,
  req: ModelRequest,
  opts: RetryOptions = {},
): AsyncGenerator<StreamEvent> {
  const profile = PROFILES[opts.strategy ?? "interactive"];
  const base = opts.baseDelayMs ?? profile.base;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let emptyRetries = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      for await (const ev of adapter.stream(req)) {
        if (ev.type === "message_done" && ev.content.length === 0) {
          throw new ModelError("empty_response", "Model returned an empty response", { retryable: true });
        }
        yield ev;
      }
      return;
    } catch (e) {
      if (!(e instanceof ModelError) || !e.retryable || req.signal?.aborted) throw e;
      const reason = reasonOf(e);
      const max = reason === "rate_limited" ? profile.rateLimitAttempts : profile.attempts;
      if (reason === "empty_response") {
        if (emptyRetries >= 1 || profile.attempts === 1) throw e;
        emptyRetries++;
      } else if (attempt >= max) {
        throw e;
      }
      let delay = base * Math.pow(profile.mult, attempt - 1) * (1 + Math.random() * 0.2);
      if (reason === "rate_limited" && e.opts.retryAfterMs !== undefined) {
        delay = Math.max(delay, e.opts.retryAfterMs * (1 + Math.random() * 0.2));
      }
      delay = Math.round(delay);
      opts.onRetry?.(attempt, reason, delay);
      await sleep(delay);
      if (req.signal?.aborted) throw new ModelError("unknown", "Request aborted", { retryable: false });
    }
  }
}
