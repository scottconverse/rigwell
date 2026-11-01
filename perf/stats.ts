// Small statistics helpers for the benchmarks.
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value with at least p percent of the samples at or below it.
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(s.length, rank) - 1]!;
}
export const median = (v: number[]) => percentile(v, 50);
export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
