// Rate limits that a provider reports in its response headers. Only numbers and reset times are kept.
// Nothing here estimates: a provider that sends no known header is shown as not available.

export interface ProviderLimit { name: string; limit: number | null; remaining: number | null; resetAt: number | null }
export interface ProviderLimitView extends ProviderLimit { resetPassed: boolean }
export interface ProviderLimitsEntry { provider: string; capturedAt: number; available: boolean; limits: ProviderLimitView[] }

const MAX_PROVIDERS = 32;
const store = new Map<string, { capturedAt: number; limits: ProviderLimit[] }>();

const count = (v: string | null): number | null => {
  const s = v?.trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** OpenAI reset values are durations such as "1s", "6m0s" or "120ms". */
export function parseDurationMs(value: string | null): number | null {
  const s = value?.trim();
  if (!s || !/^(?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) total += Number(m[1]) * UNIT_MS[m[2]!]!;
  return Number.isFinite(total) ? total : null;
}

const timestamp = (v: string | null): number | null => {
  const s = v?.trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

const row = (name: string, limit: string | null, remaining: string | null, resetAt: number | null): ProviderLimit[] => {
  const l = count(limit), r = count(remaining);
  return l === null && r === null ? [] : [{ name, limit: l, remaining: r, resetAt }];
};

export function parseProviderLimits(headers: Headers, now = Date.now()): ProviderLimit[] {
  const out: ProviderLimit[] = [];
  for (const [key, name] of [["requests", "Requests"], ["tokens", "Tokens"], ["input-tokens", "Input tokens"], ["output-tokens", "Output tokens"]] as const) {
    const p = `anthropic-ratelimit-${key}`;
    out.push(...row(name, headers.get(`${p}-limit`), headers.get(`${p}-remaining`), timestamp(headers.get(`${p}-reset`))));
  }
  for (const [key, name] of [["input-tokens", "Priority input tokens"], ["output-tokens", "Priority output tokens"]] as const) {
    const p = `anthropic-priority-${key}`;
    out.push(...row(name, headers.get(`${p}-limit`), headers.get(`${p}-remaining`), timestamp(headers.get(`${p}-reset`))));
  }
  for (const [key, name] of [["requests", "Requests"], ["tokens", "Tokens"], ["project-tokens", "Project tokens"]] as const) {
    const wait = parseDurationMs(headers.get(`x-ratelimit-reset-${key}`));
    out.push(...row(name, headers.get(`x-ratelimit-limit-${key}`), headers.get(`x-ratelimit-remaining-${key}`), wait === null ? null : now + wait));
  }
  return out;
}

/** Never throws: reading limits must not change how a model request ends. Only the host name is kept from the URL. */
export function recordProviderLimits(url: string, headers: Headers, now = Date.now()): void {
  try {
    const provider = new URL(url).host;
    const limits = parseProviderLimits(headers, now), old = store.get(provider);
    // A response without limit headers does not erase the last values that the provider did report.
    const next = limits.length || !old?.limits.length ? { capturedAt: now, limits } : old;
    store.delete(provider);
    store.set(provider, next);
    while (store.size > MAX_PROVIDERS) store.delete(store.keys().next().value!);
  } catch { /* an unreadable URL or header gives no limit data */ }
}

/** After a reset time passes, the stored remaining count is old, so it is not reported. */
export function readProviderLimits(now = Date.now()): ProviderLimitsEntry[] {
  return [...store].map(([provider, e]) => ({
    provider, capturedAt: e.capturedAt, available: e.limits.length > 0,
    limits: e.limits.map((l) => {
      const resetPassed = l.resetAt !== null && l.resetAt <= now;
      return { ...l, remaining: resetPassed ? null : l.remaining, resetPassed };
    }),
  })).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function clearProviderLimits(): void { store.clear(); }
