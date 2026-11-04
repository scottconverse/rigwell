// Minimal SSE parser + request helper shared by both adapters (fetch only, no SDKs).
import { ModelError } from "../core/types.ts";
import { classifyThrown, errorFromResponse, networkError } from "./errors.ts";

export interface SSEEvent { event?: string; data: string }

export const DEFAULT_TIMEOUT_MS = 600_000;

function parseBlock(raw: string): SSEEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === undefined) return null;
  return { event, data: data.join("\n") };
}

export async function* parseSSE(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseBlock(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Response header a server can set to change the hard time limit for that one response (ms). */
export const RESPONSE_LIMIT_HEADER = "x-response-time-limit-ms";

/**
 * POST and stream SSE events. Throws ModelError for HTTP, network, abort and timeout failures.
 * `timeoutMs` is the hard limit for the whole response; `idleMs` (optional) cuts a stream that sends no bytes
 * for that long (spec §4.2). Both surface as retryable "timeout" errors with `cause` set.
 */
export function sseRequest(
  url: string,
  init: { headers: Record<string, string>; body: string },
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
  idleMs?: number,
): AsyncGenerator<SSEEvent> {
  return guardedRequest(url, init, userSignal, timeoutMs, idleMs, parseSSE);
}

/** Same guards as sseRequest, with the body parser chosen by the caller (Bedrock reads AWS event streams). */
export async function* guardedRequest<T>(
  url: string,
  init: { headers: Record<string, string>; body: string },
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
  idleMs: number | undefined,
  parse: (body: ReadableStream<Uint8Array>, onChunk?: () => void) => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const started = Date.now();
  const timeoutCtl = new AbortController();
  const idleCtl = new AbortController();
  let limit = timeoutMs;
  let timer = setTimeout(() => timeoutCtl.abort(), limit);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleCtl.abort(), idleMs);
  };
  armIdle();
  const all = [timeoutCtl.signal, idleCtl.signal, ...(userSignal ? [userSignal] : [])];
  const signal = AbortSignal.any(all);
  const timeoutError = (): ModelError | null => {
    if (userSignal?.aborted) return null;
    if (idleCtl.signal.aborted) {
      return new ModelError("timeout", `Stream idle: no data for ${idleMs} ms`, { retryable: true, cause: "idle", elapsedMs: Date.now() - started, limitMs: idleMs });
    }
    if (timeoutCtl.signal.aborted) {
      return new ModelError("timeout", `Response ran past the time limit (${limit} ms)`, { retryable: true, cause: "hard_limit", elapsedMs: Date.now() - started, limitMs: limit });
    }
    return null;
  };
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
    } catch (e) {
      throw timeoutError() ?? classifyThrown(e, userSignal);
    }
    const hdr = Number(res.headers.get(RESPONSE_LIMIT_HEADER));
    if (Number.isFinite(hdr) && hdr > 0) {
      limit = hdr;
      clearTimeout(timer);
      timer = setTimeout(() => timeoutCtl.abort(), Math.max(1, limit - (Date.now() - started)));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw errorFromResponse(res.status, res.headers, text);
    }
    if (!res.body) throw networkError("response had no body");
    armIdle();
    try {
      for await (const ev of parse(res.body, armIdle)) yield ev;
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw timeoutError() ?? classifyThrown(e, userSignal);
    }
    // The body can end quietly when the abort closes it: report the cut instead of a normal end.
    const cut = timeoutError();
    if (cut) throw cut;
  } finally {
    clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    timeoutCtl.abort(); // cancels the connection if the consumer stopped early
  }
}

/** `${base}/v1/<path>`, without doubling /v1 and tolerating trailing slashes. */
export function apiUrl(baseUrl: string, path: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return b.endsWith("/v1") ? `${b}/${path}` : `${b}/v1/${path}`;
}

export function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}
