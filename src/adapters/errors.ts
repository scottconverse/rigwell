// Shared HTTP/network error mapping (spec §4.6.9).
import { ModelError } from "../core/types.ts";

const RETRY_AFTER_FLOOR_MS = 5_000;
const RETRY_AFTER_CAP_MS = 30_000;

function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms))) return Number(ms);
  const ra = headers.get("retry-after");
  if (ra === null || ra.trim() === "") return undefined;
  if (Number.isFinite(Number(ra))) return Number(ra) * 1000;
  const date = Date.parse(ra);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function bodyMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string" && m) return m;
  } catch {}
  return body.slice(0, 500);
}

/** Map a non-2xx HTTP response to a ModelError. */
export function errorFromResponse(status: number, headers: Headers, body: string): ModelError {
  const msg = `HTTP ${status}: ${bodyMessage(body) || "(empty body)"}`;
  const noRetry = headers.get("x-should-retry")?.trim().toLowerCase() === "false";
  const mk = (
    kind: ConstructorParameters<typeof ModelError>[0],
    retryable: boolean,
    extra: { retryAfterMs?: number } = {},
  ) => new ModelError(kind, msg, { status, retryable: retryable && !noRetry, ...extra });

  if (status === 401 || status === 403) return mk("auth", false);
  if (status === 408) return mk("timeout", true);
  if (status === 429) {
    const ra = parseRetryAfterMs(headers);
    const clamped = ra === undefined ? undefined : Math.min(RETRY_AFTER_CAP_MS, Math.max(RETRY_AFTER_FLOOR_MS, ra));
    return mk("rate_limited", true, { retryAfterMs: clamped });
  }
  if (status === 500) {
    if (/overloaded/i.test(body)) return mk("overloaded", true);
    if (/internal error|unavailable/i.test(body)) return mk("unavailable", true);
    return mk("unknown", false);
  }
  if (status === 502 || status === 503) return mk("unavailable", true);
  if (status === 529) return mk("overloaded", true);
  if (status >= 400 && status < 500) return mk("rejected", false);
  return mk("unknown", false);
}

export function networkError(detail: string): ModelError {
  return new ModelError("network", `Network error: ${detail}`, { retryable: true });
}

/** Connection closed before the provider's final event. */
export function midStreamBreak(): ModelError {
  return networkError("connection closed before the final stream event");
}

/** Classify an exception thrown by fetch() or while reading the body. */
export function classifyThrown(e: unknown, userSignal?: AbortSignal, timeoutSignal?: AbortSignal): ModelError {
  if (e instanceof ModelError) return e;
  if (userSignal?.aborted) return new ModelError("unknown", "Request aborted", { retryable: false });
  if (timeoutSignal?.aborted) return new ModelError("timeout", "Request timed out", { retryable: true });
  return networkError(e instanceof Error ? e.message : String(e));
}
