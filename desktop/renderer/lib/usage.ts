// Usage page logic (spec §14.3): local token totals only. Plan limits are hosted and not shown.
export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; thinkingTokens?: number }
export const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 });
export function addUsage(a: TokenUsage, b?: Partial<TokenUsage>): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0), outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0), cacheCreationTokens: a.cacheCreationTokens + (b.cacheCreationTokens ?? 0),
    thinkingTokens: (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0),
  };
}
export const total = (u: TokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
export function fmt(n: number): string { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n); }
export function percentUsed(used: number, limit: number): number { return limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0; }
