import type { Price, TokenCounts } from "./types.ts";

/** Cost in USD. inputTokens are the uncached input tokens (the adapters report them that way). */
export function costOf(t: TokenCounts, p: Price | undefined): number {
  if (!p) return 0;
  const write = p.cacheWritePerMtok ?? p.inputPerMtok;
  return (t.input * p.inputPerMtok + t.cacheRead * p.cachedInputPerMtok + t.cacheCreation * write + t.output * p.outputPerMtok) / 1e6;
}

/** Share of input-side tokens served from cache. */
export function cacheHitRate(t: TokenCounts): number {
  const total = t.input + t.cacheRead + t.cacheCreation;
  return total === 0 ? 0 : t.cacheRead / total;
}
