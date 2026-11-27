// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/*
  The "use whatever model is loaded" sentinel and the first-run decision.
*/

import {
  pickLoadedLocalModelAcrossServers,
  type LocalCatalog,
} from "./local-discovery.ts";

/** Stored instead of a named model: resolve to whatever is loaded at call time. */
export const LOADED_SENTINEL = { baseUrl: "*", id: "*" } as const;

export type StoredLocalChoice = { baseUrl: string; id: string };

export function isLoadedSentinel(choice: StoredLocalChoice | null | undefined): boolean {
  return Boolean(choice && choice.baseUrl === LOADED_SENTINEL.baseUrl && choice.id === LOADED_SENTINEL.id);
}

export type ResolvedChoice = {
  override: StoredLocalChoice | null;
  source: "loaded" | "stored" | "default";
};

/**
 * Resolve a stored local choice against a live catalog. The sentinel resolves
 * now, not when it was saved. Nothing stored means the loaded model, else the
 * catalog's default.
 */
export function resolveLoadedChoice(
  choice: StoredLocalChoice | null | undefined,
  catalog: LocalCatalog,
): ResolvedChoice {
  if (isLoadedSentinel(choice)) {
    return { override: pickLoadedLocalModelAcrossServers(catalog.servers), source: "loaded" };
  }
  if (!choice) {
    const loaded = pickLoadedLocalModelAcrossServers(catalog.servers);
    if (loaded) return { override: loaded, source: "loaded" };
    return { override: catalog.defaultModel, source: "default" };
  }
  const listed = catalog.servers.some(
    (server) => server.baseUrl === choice.baseUrl && server.models.some((model) => model.id === choice.id),
  );
  if (listed) return { override: choice, source: "stored" };
  return { override: catalog.defaultModel, source: "default" };
}

export type FirstRunPlan =
  | { plan: "stored"; model: StoredLocalChoice }
  | { plan: "offered" }
  | { plan: "none" };

/**
 * What a first run should do, from a catalog alone: store the loaded model,
 * offer the card (a server answers but nothing is in memory), or do nothing.
 * A cloud model is never picked: it spends credits and never runs here.
 */
export function firstRunPlan(catalog: LocalCatalog): FirstRunPlan {
  const servers = catalog.servers.map((server) => ({
    ...server,
    models: server.models.filter((model) => !model.cloud),
  }));
  const loaded = pickLoadedLocalModelAcrossServers(servers);
  if (loaded) return { plan: "stored", model: loaded };
  return servers.some((server) => server.reachable) ? { plan: "offered" } : { plan: "none" };
}
