// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/* Small pure helpers the screens share. No React, no I/O. */

import type { LocalServerKind } from "../../../../../src/model-setup/core/local-discovery.ts";

export const SERVER_KIND_LABEL: Record<LocalServerKind, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  "openai-compatible": "OpenAI-compatible server",
};

/** The host part of a base URL, or the URL itself when it does not parse. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export function isLoopbackUrl(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
}

/** "M:SS" from a whole number of seconds. */
export function countdownText(totalSeconds: number): string {
  const left = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** A message for a caught value, never throwing. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The first `count` entries, always keeping the chosen one visible. */
export function visibleModels<T extends { id: string }>(
  models: T[],
  count: number,
  keepId?: string,
): T[] {
  return models.filter((model, index) => index < count || model.id === keepId);
}
