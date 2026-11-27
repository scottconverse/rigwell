// Copied from model-setup-kit 17b7660. Do not edit here; change the kit and copy again.
/** Shared helpers for the core. Node built-ins only; no runtime dependencies. */

/** The streaming part of a `fetch` response body. */
export type BodyReaderLike = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
};

export type BodyStreamLike = { getReader(): BodyReaderLike };

/** The small part of `fetch`'s response this kit reads. */
export type FetchResponseLike = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  body?: BodyStreamLike | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
  redirect?: "follow" | "error" | "manual";
};

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

/** The global fetch, typed through the narrow shape above. */
export const defaultFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

/** Reject a promise that takes too long, so a hung port cannot stall a screen. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "timed out"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An error body is only a message; never read more than this. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A successful body may legitimately be large: a provider's public model list
 * can approach a megabyte. This is still a ceiling, not a target.
 */
export const MAX_SUCCESS_BODY_BYTES = 8 * 1024 * 1024;

export type BodyReadResult = {
  text: string;
  /** True when the body went past the cap and reading stopped there. */
  truncated: boolean;
};

/**
 * Read a response body but never more than `maxBytes`: a server that streams
 * without end cannot keep the caller waiting or fill memory. The stream is
 * cancelled as soon as the cap is reached.
 */
export async function readBodyCapped(
  response: { body?: BodyStreamLike | null; text(): Promise<string> },
  options: { maxBytes?: number; onReader?: (reader: BodyReaderLike) => void } = {},
): Promise<BodyReadResult> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const whole = await response.text().catch(() => "");
    const text = whole.slice(0, maxBytes);
    return { text, truncated: text.length < whole.length };
  }
  const reader = body.getReader();
  options.onReader?.(reader);
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    if (!value || value.length === 0) continue;
    const room = maxBytes - received;
    if (value.length > room) {
      text += decoder.decode(value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => undefined);
      return { text: text + decoder.decode(), truncated: true };
    }
    text += decoder.decode(value, { stream: true });
    received += value.length;
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: text + decoder.decode(), truncated: true };
    }
  }
}

export type FetchBodyResult = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text: string;
  truncated: boolean;
};

/**
 * Fetch and read the body under one deadline: a server that sends headers and
 * then stalls still times out. Aborts the request and cancels the body reader
 * at the deadline, so nothing keeps reading after the caller gave up.
 */
export async function fetchBodyWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: FetchInit,
  ms: number,
  label = "timed out",
): Promise<FetchBodyResult> {
  const controller = new AbortController();
  let activeReader: BodyReaderLike | null = null;
  // Set before the reader is cancelled, so a cancel that unblocks the read
  // still reports a timeout rather than an empty body.
  let timedOut = false;
  const stopReader = () => {
    const reader = activeReader;
    activeReader = null;
    if (reader) void reader.cancel(new Error(label)).catch(() => undefined);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    stopReader();
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  const work = (async () => {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const read = await readBodyCapped(response, {
      // An error body only carries a message; a success body may be a whole
      // model list, so it gets the larger cap. The deadline is unchanged.
      maxBytes: response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_BODY_BYTES,
      onReader: (reader) => {
        activeReader = reader;
      },
    });
    activeReader = null;
    if (timedOut) throw new Error(label);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText ?? "",
      headers: response.headers,
      text: read.text,
      truncated: read.truncated,
    };
  })();
  try {
    return await withTimeout(work, ms, label);
  } catch (error) {
    // An abort surfaces as AbortError; the caller wants the plain deadline word.
    if (timedOut) throw new Error(label);
    throw error;
  } finally {
    clearTimeout(timer);
    activeReader = null;
  }
}

/** Remove trailing slashes from a URL without touching the rest. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** http://127.0.0.1:1234/v1 -> http://127.0.0.1:1234 */
export function serverRoot(baseUrl: string): string {
  return trimSlash(baseUrl).replace(/\/v1$/, "");
}

/** Join a base URL and an endpoint path with exactly one slash between them. */
export function joinEndpoint(baseUrl: string, pathName: string): string {
  return `${trimSlash(baseUrl)}/${pathName.replace(/^\//, "")}`;
}

/** True for a hostname that names this computer. */
export function isLoopbackHost(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}
