// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/** Shared helpers for the core. Node built-ins only; no runtime dependencies. */

/** The small part of `fetch`'s response this kit reads. */
export type FetchResponseLike = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
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
