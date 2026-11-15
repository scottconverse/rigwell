import { configuredPrices, readAnalytics } from "../analytics/analytics.ts";
import { loadSettings } from "../storage/settings.ts";
import { rigwellHome } from "../storage/paths.ts";
import { ModelError, type TokenUsage } from "../core/types.ts";
import { appendAnalyticsMetric, createSession } from "../storage/transcript.ts";
import { updateSessionSettings } from "../storage/session-settings.ts";
import { hasSpendCaps, parseSpendLimits, type SpendLimits } from "./config.ts";

export class SpendLimitError extends ModelError {
  constructor(message: string, readonly scope: "overall" | "model", readonly modelId?: string) { super("rejected", message, { retryable: false }); this.name = "SpendLimitError"; }
}
export function spendConfig() { return parseSpendLimits(loadSettings({ cwd: rigwellHome(), trusted: false }).settings.spendLimits); }
export function readSpendStatus(now = new Date(), config: SpendLimits = spendConfig()) {
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7) + "-01", enabled = hasSpendCaps(config);
  const rows: { model?: string; period: "day" | "month"; capUsd: number; spentUsd: number | null; remainingUsd: number | null; status: "ok" | "warning" | "blocked" | "unknown" }[] = [];
  let coverage: { legacyForks: number; skippedLines: number; undatedExcluded: number } | undefined;
  if (enabled) {
    for (const period of ["day", "month"] as const) {
      const report = readAnalytics({ group: "model", from: period === "day" ? day : month, to: day }); coverage = report.coverage;
      for (const [model, caps] of [[undefined, config], ...Object.entries(config.models ?? {})] as [string | undefined, SpendLimits][]) {
        const capUsd = caps[period === "day" ? "dailyUsd" : "monthlyUsd"]; if (capUsd === undefined) continue;
        const usage = model === undefined ? report.totals : report.rows.find((r) => r.key === model), spentUsd = usage ? usage.costUsd : 0;
        const status = spentUsd === null ? "unknown" : spentUsd >= capUsd ? "blocked" : spentUsd >= capUsd * (config.warnAt ?? .8) ? "warning" : "ok";
        rows.push({ ...(model === undefined ? {} : { model }), period, capUsd, spentUsd, remainingUsd: spentUsd === null ? null : Math.max(0, capUsd - spentUsd), status });
      }
    }
  }
  return { enabled, config, day, month, rows, coverage, prices: enabled ? configuredPrices() : {}, basis: "Recorded dated local usage at configured estimates. UTC day/month. Unreported, undated, deleted and remote history cannot establish actual billing." };
}
export function spendWarnings(status: ReturnType<typeof readSpendStatus>, model?: string) {
  return status.rows.filter((r) => (r.model === undefined || r.model === model) && ["warning", "blocked", "unknown"].includes(r.status)).map((r) => ({ key: JSON.stringify([r.model, r.period, r.capUsd, r.status]), text: `${r.model ?? "Overall"} ${r.period} spend ${r.status}: ${r.spentUsd === null ? "unknown" : `$${r.spentUsd.toFixed(6)}`} of $${r.capUsd.toFixed(6)} estimated.` }));
}
/** No provider call or forecast reservation. In-flight requests may finish above the configured cap. */
export function assertSpend(model?: string): ReturnType<typeof readSpendStatus> {
  const status = readSpendStatus(); if (!status.enabled) return status;
  const relevant = status.rows.filter((r) => r.model === undefined || r.model === model);
  for (const r of relevant) if (r.status === "blocked" || r.status === "unknown") throw new SpendLimitError(`${r.model ?? "Overall"} ${r.period} spend ${r.status === "unknown" ? "cannot be priced" : "cap reached"}. Check Usage settings before starting more requests.`, r.model === undefined ? "overall" : "model", r.model);
  if (model && relevant.length && !status.prices[model]) throw new SpendLimitError(`Spend caps require an explicit analytics.prices entry for ${model}; unknown prices are not zero.`, "model", model);
  return status;
}
export const spendMethods = { get_spend_status: () => readSpendStatus() };

/** Non-agent evaluator requests still enter the same dated accounting source of truth. */
export async function recordJudgeUsage(id: string, model: string, usage: TokenUsage) {
  const files = createSession({ id, cwd: rigwellHome(), title: "Evaluation judge" });
  updateSessionSettings(files, { hasUserVisibleMessages: false, tags: [{ name: "eval-judge" }] });
  await appendAnalyticsMetric(files, { kind: "usage", model, usage, purpose: "eval-judge" });
}
