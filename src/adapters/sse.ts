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

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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

/** POST and stream SSE events. Throws ModelError for HTTP, network, abort and timeout failures. */
export async function* sseRequest(
  url: string,
  init: { headers: Record<string, string>; body: string },
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AsyncGenerator<SSEEvent> {
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const all = userSignal ? [timeoutCtl.signal, userSignal] : [timeoutCtl.signal];
  const signal = AbortSignal.any(all);
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
    } catch (e) {
      throw classifyThrown(e, userSignal, timeoutCtl.signal);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw errorFromResponse(res.status, res.headers, text);
    }
    if (!res.body) throw networkError("response had no body");
    try {
      for await (const ev of parseSSE(res.body)) yield ev;
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw classifyThrown(e, userSignal, timeoutCtl.signal);
    }
  } finally {
    clearTimeout(timer);
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
