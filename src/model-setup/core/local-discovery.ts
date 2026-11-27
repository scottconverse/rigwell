// Copied from model-setup-kit 869cdf5. Do not edit here; change the kit and copy again.
/*
  Finds local, OpenAI-compatible model servers on this machine with no typing
  from the operator: the same ports and rules as the product this kit was
  extracted from. Never throws: a server that does not answer, times out, or
  answers with something that is not the expected JSON shape is treated as
  absent, not as an error.
*/

import {
  defaultFetch,
  isLoopbackHost,
  serverRoot,
  trimSlash,
  withTimeout,
  type FetchLike,
} from "./util.ts";

export type LocalServerKind = "lmstudio" | "ollama" | "llamacpp" | "openai-compatible";

export type LocalModel = {
  id: string;
  /** null when the server reports no load state (plain OpenAI-compatible). */
  loaded: boolean | null;
  vision: boolean;
  /** Answers with reasoning content instead of content by default. */
  thinking: boolean;
  /** Reported context window, when the server reports one. */
  contextLength?: number;
  /** Hosted by Ollama; never runs on this computer and spends credits. */
  cloud: boolean;
};

export type LocalServer = {
  kind: LocalServerKind;
  baseUrl: string;
  /**
   * False only for a server the caller pointed at with `extraBaseUrls` and
   * that did not answer. A probed default port that does not answer is left
   * out of `servers` entirely.
   */
  reachable: boolean;
  models: LocalModel[];
};

export type LocalCatalog = {
  servers: LocalServer[];
  defaultModel: { baseUrl: string; id: string } | null;
  checkedAt: number;
};

/** Ports probed by default: LM Studio, Ollama, Ollama's own copy, llama.cpp. */
export const DEFAULT_LOCAL_ADDRESSES: readonly string[] = [
  "http://127.0.0.1:1234/v1",
  "http://127.0.0.1:11434/v1",
  "http://127.0.0.1:11435/v1",
  "http://127.0.0.1:8080/v1",
];

export const THINKING_RE =
  /gemma-?4|qwen3(?:\.\d+)?|deepseek-(?:r1|v4(?:\.\d+)?)(?:[:/-]|$)|gpt-oss|o[134]-|reasoning|think/i;

export function isThinkingId(id: string): boolean {
  return THINKING_RE.test(id);
}

export function inferKind(baseUrl: string): LocalServerKind {
  if (/:1234\b/.test(baseUrl)) return "lmstudio";
  if (/:11434\b/.test(baseUrl) || /:11435\b/.test(baseUrl)) return "ollama";
  if (/:8080\b/.test(baseUrl)) return "llamacpp";
  return "openai-compatible";
}

/** True for an Ollama id routed to Ollama's hosted service. */
export function isCloudLocalModelId(id: string): boolean {
  return /[:.-]cloud$/i.test(id);
}

const PROBE_TIMEOUT_MS = 1_500;

async function fetchJson(url: string, fetchFn: FetchLike, timeoutMs: number): Promise<unknown> {
  const res = await withTimeout(fetchFn(url, { headers: { Accept: "application/json" } }), timeoutMs);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  // A port may answer 200 with an unrelated web page. Refuse to parse HTML.
  if (contentType && !/json/i.test(contentType)) throw new Error(`${url} is not JSON`);
  return res.json();
}

/** `{data:[{id}...]}` — the one shape every OpenAI-compatible `/models` list shares. */
export function parseModelIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

const LLAMACPP_VISION_RE = /vl|vision|gemma-?4|glm-4\.\d*v/i;

type LmStudioNativeModel = { id?: string; state?: string; type?: string };

async function enrichLmStudio(root: string, ids: string[], fetchFn: FetchLike): Promise<LocalModel[]> {
  let native: LmStudioNativeModel[] = [];
  try {
    const body = (await fetchJson(`${root}/api/v0/models`, fetchFn, PROBE_TIMEOUT_MS)) as {
      data?: LmStudioNativeModel[];
    };
    native = Array.isArray(body?.data) ? body.data : [];
  } catch {
    // No native endpoint: fall back to the plain list with no load information.
  }
  const byId = new Map(native.map((m) => [m.id, m]));
  const out: LocalModel[] = [];
  for (const id of ids) {
    const meta = byId.get(id);
    if (meta?.type === "embeddings") continue;
    out.push({
      id,
      loaded: meta ? meta.state === "loaded" : null,
      thinking: isThinkingId(id),
      vision: meta?.type === "vlm",
      cloud: false,
    });
  }
  return out;
}

async function ollamaMetadata(
  root: string,
  id: string,
  fetchFn: FetchLike,
): Promise<{ vision: boolean; contextLength?: number }> {
  try {
    const res = await withTimeout(
      fetchFn(`${root}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: id, model: id }),
      }),
      PROBE_TIMEOUT_MS,
    );
    if (!res.ok) return { vision: false };
    const body = (await res.json()) as {
      capabilities?: unknown;
      model_info?: Record<string, unknown>;
    };
    const context = Object.entries(body.model_info ?? {}).find(
      ([key, value]) => /(?:^|\.)context_length$/i.test(key) && Number.isFinite(value),
    )?.[1];
    const vision = Array.isArray(body.capabilities) && body.capabilities.includes("vision");
    return typeof context === "number" && context > 0
      ? { vision, contextLength: context }
      : { vision };
  } catch {
    return { vision: false };
  }
}

async function enrichOllama(root: string, ids: string[], fetchFn: FetchLike): Promise<LocalModel[]> {
  let running = new Set<string>();
  /* True when /api/ps answered, even with no running models. Only a failed
     call leaves the load state unknown (null). */
  let known = false;
  try {
    const body = (await fetchJson(`${root}/api/ps`, fetchFn, PROBE_TIMEOUT_MS)) as {
      models?: { name?: string; model?: string }[];
    };
    known = true;
    running = new Set(
      (body?.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((name): name is string => typeof name === "string"),
    );
  } catch {
    // /api/ps missing or unreachable: loaded state stays unknown, not an error.
  }
  const metadata = await Promise.all(ids.map((id) => ollamaMetadata(root, id, fetchFn)));
  return ids.map((id, i) => {
    const meta = metadata[i] ?? { vision: false };
    return {
      id,
      loaded: known ? running.has(id) : null,
      thinking: isThinkingId(id),
      vision: meta.vision,
      ...(meta.contextLength ? { contextLength: meta.contextLength } : {}),
      cloud: isCloudLocalModelId(id),
    };
  });
}

function enrichLlamaCpp(ids: string[]): LocalModel[] {
  return ids.map((id) => ({
    id,
    loaded: null,
    thinking: isThinkingId(id),
    vision: LLAMACPP_VISION_RE.test(id),
    cloud: false,
  }));
}

function enrichPlain(ids: string[]): LocalModel[] {
  return ids.map((id) => ({
    id,
    loaded: null,
    thinking: isThinkingId(id),
    vision: false,
    cloud: false,
  }));
}

async function probeServer(
  baseUrl: string,
  kind: LocalServerKind,
  alwaysInclude: boolean,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<LocalServer | null> {
  const base = trimSlash(baseUrl);
  let ids: string[] | null = null;
  try {
    ids = parseModelIds(await fetchJson(`${base}/models`, fetchFn, timeoutMs));
  } catch {
    ids = null;
  }
  if (ids === null) {
    return alwaysInclude ? { kind, baseUrl: base, reachable: false, models: [] } : null;
  }
  const models =
    kind === "lmstudio"
      ? await enrichLmStudio(serverRoot(base), ids, fetchFn)
      : kind === "ollama"
        ? await enrichOllama(serverRoot(base), ids, fetchFn)
        : kind === "llamacpp"
          ? enrichLlamaCpp(ids)
          : enrichPlain(ids);
  return { kind, baseUrl: base, reachable: true, models };
}

const SERVER_PRIORITY: LocalServerKind[] = [
  "lmstudio",
  "ollama",
  "llamacpp",
  "openai-compatible",
];

function orderedServers(servers: LocalServer[]): LocalServer[] {
  return servers
    .filter((s) => s.reachable)
    .slice()
    .sort((a, b) => SERVER_PRIORITY.indexOf(a.kind) - SERVER_PRIORITY.indexOf(b.kind));
}

/** The one loaded chat model on this server, lowest id first, or null. */
export function pickLoadedLocalModel(server: LocalServer): LocalModel | null {
  const loaded = server.models
    .filter((m) => m.loaded === true)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return loaded[0] ?? null;
}

/** The one loaded model anywhere on this machine, in server priority order. */
export function pickLoadedLocalModelAcrossServers(
  servers: LocalServer[],
): { baseUrl: string; id: string } | null {
  for (const server of orderedServers(servers)) {
    const loaded = pickLoadedLocalModel(server);
    if (loaded) return { baseUrl: server.baseUrl, id: loaded.id };
  }
  return null;
}

/**
 * The default model for a catalog: something loaded right now, else the
 * caller's preferred id if a reachable server lists it, else null. It never
 * falls back to "the first downloaded entry", which is usually not in memory.
 */
export function pickDefault(
  servers: LocalServer[],
  preferredModel?: string,
): { baseUrl: string; id: string } | null {
  const loaded = pickLoadedLocalModelAcrossServers(servers);
  if (loaded) return loaded;
  const wanted = preferredModel?.trim();
  if (wanted) {
    for (const server of orderedServers(servers)) {
      if (server.models.some((m) => m.id === wanted)) {
        return { baseUrl: server.baseUrl, id: wanted };
      }
    }
  }
  return null;
}

/** Loopback, or an address discovery just found on this machine. */
export function isAllowedLocalAddress(url: string, catalog: LocalCatalog | null): boolean {
  const trimmed = trimSlash(url);
  try {
    if (isLoopbackHost(new URL(trimmed).hostname)) return true;
  } catch {
    return false;
  }
  return Boolean(catalog?.servers.some((server) => server.baseUrl === trimmed));
}

export type DiscoverOptions = {
  /** Addresses to probe first. Unreachable ones are listed with reachable:false. */
  extraBaseUrls?: string[];
  /** Probe DEFAULT_LOCAL_ADDRESSES too. Default true. */
  includeDefaults?: boolean;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
};

export async function discoverLocalServers(options: DiscoverOptions = {}): Promise<LocalCatalog> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const servers: LocalServer[] = [];
  const seen = new Set<string>();

  for (const raw of options.extraBaseUrls ?? []) {
    const base = trimSlash(raw);
    if (!base || seen.has(base)) continue;
    const server = await probeServer(base, inferKind(base), true, fetchFn, timeoutMs);
    if (server) {
      servers.push(server);
      seen.add(base);
    }
  }

  if (options.includeDefaults !== false) {
    for (const base of DEFAULT_LOCAL_ADDRESSES) {
      if (seen.has(base)) continue;
      const server = await probeServer(base, inferKind(base), false, fetchFn, timeoutMs);
      if (server) servers.push(server);
    }
  }

  return { servers, defaultModel: pickDefault(servers), checkedAt: now() };
}

const CACHE_MS = 20_000;
let cache: { catalog: LocalCatalog; at: number } | null = null;

/**
 * The live catalog, cached for 20 seconds. Pass `force: true` to probe again.
 * Callers that inject fakes should use `discoverLocalServers` directly, or
 * reset the cache first.
 */
export async function refreshCatalog(
  force = false,
  options: DiscoverOptions = {},
): Promise<LocalCatalog> {
  const now = options.now ?? Date.now;
  const at = now();
  if (!force && cache && at - cache.at < CACHE_MS) return cache.catalog;
  const catalog = await discoverLocalServers(options);
  cache = { catalog, at };
  return catalog;
}

/** Drop the cached catalog. */
export function resetCatalogCache(): void {
  cache = null;
}
