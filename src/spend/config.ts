// Shared with Electron: pure validation, no runtime or credential imports.
export interface Caps { dailyUsd?: number; monthlyUsd?: number }
export interface SpendLimits extends Caps { warnAt?: number; models?: Record<string, Caps> }
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Spend periods are UTC: the next UTC midnight, or the first moment of the next UTC month. */
export function spendPeriodResetAt(period: "day" | "month", now = new Date()): number {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return period === "day" ? Date.UTC(y, m, now.getUTCDate() + 1) : Date.UTC(y, m + 1, 1);
}
export function parseSpendLimits(value: unknown): SpendLimits {
  if (value === undefined || value === null) return {};
  if (!plain(value) || Object.keys(value).some((k) => !["dailyUsd", "monthlyUsd", "warnAt", "models"].includes(k))) throw new Error("Invalid spendLimits object");
  const caps = (v: unknown): Caps => {
    if (!plain(v) || Object.keys(v).some((k) => !["dailyUsd", "monthlyUsd"].includes(k))) throw new Error("Use dailyUsd and monthlyUsd caps");
    for (const n of Object.values(v)) if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("Spend caps must be finite nonnegative USD amounts");
    return { ...v };
  };
  const result: SpendLimits = caps(Object.fromEntries(Object.entries(value).filter(([k]) => ["dailyUsd", "monthlyUsd"].includes(k))));
  if (value.warnAt !== undefined) { if (typeof value.warnAt !== "number" || !Number.isFinite(value.warnAt) || value.warnAt <= 0 || value.warnAt > 1) throw new Error("warnAt must be greater than zero and at most one"); result.warnAt = value.warnAt; }
  if (value.models !== undefined) {
    if (!plain(value.models) || Object.keys(value.models).length > 1000) throw new Error("Invalid per-model spend caps");
    result.models = Object.create(null);
    for (const [id, limits] of Object.entries(value.models)) { if (!id.trim() || id.length > 300 || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid spend model id"); result.models![id] = caps(limits); }
  }
  return result;
}
export function hasSpendCaps(config: SpendLimits) { return [config, ...Object.values(config.models ?? {})].some((c) => c.dailyUsd !== undefined || c.monthlyUsd !== undefined); }
