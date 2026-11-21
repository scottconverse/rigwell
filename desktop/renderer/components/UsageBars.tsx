import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import { spendPeriodResetAt } from "../../../src/spend/config.ts";
import type { ProviderLimitsEntry, ProviderLimitView } from "../../../src/adapters/provider-limits.ts";
import type { readSpendStatus } from "../../../src/spend/spend.ts";

type SpendRow = ReturnType<typeof readSpendStatus>["rows"][number];
const localTime = (ms: number) => new Date(ms).toLocaleString();
const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export function SpendBars({ rows, warnAt }: { rows: SpendRow[]; warnAt: number }) {
  if (!rows.length) return null;
  return <table className="table" aria-label="Spend limit bars"><thead><tr><th>Limit</th><th>Used</th><th>Resets (local time)</th></tr></thead><tbody>{rows.map((r, i) => {
    const label = `${r.model ?? "Overall"} ${r.period === "day" ? "daily" : "monthly"}`;
    const percent = r.spentUsd === null ? null : r.capUsd > 0 ? clampPercent((r.spentUsd / r.capUsd) * 100) : 100;
    return <tr key={i}><th>{label}</th><td>{percent === null ? "Unknown" : <><meter min={0} max={100} high={warnAt * 100} value={percent} aria-label={`${label} spend used`} /> <span className="small">${r.spentUsd!.toFixed(2)} of ${r.capUsd} ({percent}%)</span></>}</td><td className="small">{localTime(spendPeriodResetAt(r.period))}</td></tr>;
  })}</tbody></table>;
}

function limitUsed(l: ProviderLimitView) {
  if (l.resetPassed) return <span className="small">Reset time passed. New value comes with the next response.</span>;
  if (l.limit === null || l.remaining === null || l.limit === 0) return <span className="small">{l.remaining === null ? "Remaining not reported" : `${l.remaining.toLocaleString()} remaining`}</span>;
  const percent = clampPercent(((l.limit - l.remaining) / l.limit) * 100);
  return <><meter min={0} max={100} value={percent} aria-label={`${l.name} used`} /> <span className="small">{l.remaining.toLocaleString()} of {l.limit.toLocaleString()} remaining</span></>;
}

export function ProviderLimits() {
  const [providers, setProviders] = useState<ProviderLimitsEntry[]>(), [error, setError] = useState("");
  const refresh = async () => {
    try { setProviders((await app.request<{ providers: ProviderLimitsEntry[] }>("get_provider_limits")).providers); setError(""); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void refresh(); }, []);
  return <section aria-label="Provider limits"><h3>Provider limits</h3><p className="muted">Values that each provider reported on its latest response. Rigwell does not estimate them.</p>
    {error && <p className="muted">{error}</p>}
    {providers && !providers.length && <p className="muted">No provider has answered since Rigwell started.</p>}
    {providers?.map((p) => <div key={p.provider} data-testid="provider-limit"><h4>{p.provider}</h4>{p.available
      ? <><table className="table" aria-label={`${p.provider} limits`}><thead><tr><th>Limit</th><th>Used</th><th>Resets (local time)</th></tr></thead><tbody>{p.limits.map((l) => <tr key={l.name}><th>{l.name}</th><td>{limitUsed(l)}</td><td className="small">{l.resetAt === null ? "Not reported" : localTime(l.resetAt)}</td></tr>)}</tbody></table><p className="muted small">Reported {localTime(p.capturedAt)}</p></>
      : <p className="muted">Not available from this provider</p>}</div>)}
    <button onClick={() => void refresh()}>Refresh provider limits</button>
  </section>;
}
