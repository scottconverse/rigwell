import { useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { parseSpendLimits } from "../../../src/spend/config.ts";
import type { readSpendStatus } from "../../../src/spend/spend.ts";
type Status = ReturnType<typeof readSpendStatus>;

export function SpendLimits() {
  const a = useApp(), [status, setStatus] = useState<Status>(), [daily, setDaily] = useState(""), [monthly, setMonthly] = useState(""), [threshold, setThreshold] = useState("0.8"), [models, setModels] = useState("{}"), [prices, setPrices] = useState("{}"), [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const refresh = async () => { const s = await app.request<Status>("get_spend_status"); setStatus(s); return s; };
  useEffect(() => { void (async () => { try {
    const s = await refresh(), config = a.userSettings.spendLimits ?? s.config;
    setDaily(config.dailyUsd === undefined ? "" : String(config.dailyUsd)); setMonthly(config.monthlyUsd === undefined ? "" : String(config.monthlyUsd)); setThreshold(String(config.warnAt ?? .8)); setModels(JSON.stringify(config.models ?? {}, null, 2)); setPrices(JSON.stringify(a.userSettings.analytics?.prices ?? {}, null, 2));
  } catch (e) { setError((e as Error).message); } })(); }, []);
  const save = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      const limits = parseSpendLimits({ ...(daily.trim() ? { dailyUsd: Number(daily) } : {}), ...(monthly.trim() ? { monthlyUsd: Number(monthly) } : {}), warnAt: Number(threshold), models: JSON.parse(models) });
      const values = JSON.parse(prices); if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Prices must be an object keyed by profile ID");
      for (const p of Object.values(values) as any[]) if (!p || ![p.inputPerMtok, p.cachedInputPerMtok, p.outputPerMtok, p.cacheWritePerMtok ?? p.inputPerMtok].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("Each price needs finite nonnegative inputPerMtok, cachedInputPerMtok and outputPerMtok");
      await app.updateUserSettings({ spendLimits: limits, analytics: { ...(a.userSettings.analytics ?? {}), prices: values } }); await refresh(); setNote("Spend limits saved. New admissions use the effective settings below.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section aria-label="Local spend limits"><h3>Local spend limits</h3><p>USD estimates from recorded local usage, with UTC daily and monthly periods. Blank removes a cap; zero prevents new work. Active requests can finish above a cap. Provider billing, missing history and remote machines are not measured here.</p>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
    <label>Overall daily USD<input aria-label="Overall daily USD" type="number" min="0" step="any" value={daily} onChange={(e) => setDaily(e.target.value)} /></label>
    <label>Overall monthly USD<input aria-label="Overall monthly USD" type="number" min="0" step="any" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></label>
    <label>Warning fraction<input aria-label="Warning fraction" type="number" min="0.01" max="1" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
    <label>Per-model caps JSON<textarea aria-label="Per-model caps JSON" value={models} onChange={(e) => setModels(e.target.value)} /></label><p>Map exact profile IDs to dailyUsd and/or monthlyUsd. Caps on other profiles do not block the selected profile.</p>
    <label>Estimated prices JSON<textarea aria-label="Estimated prices JSON" value={prices} onChange={(e) => setPrices(e.target.value)} /></label><p>Map profile IDs to inputPerMtok, cachedInputPerMtok, outputPerMtok and optional cacheWritePerMtok, all USD per million tokens. Unknown prices refuse capped requests. An explicit zero is an estimate you choose, not measured subscription billing.</p>
    <button disabled={busy} onClick={() => void save()}>Save spend limits</button><button disabled={busy} onClick={() => void refresh().catch((e) => setError(e.message))}>Refresh spending</button>
    {status && <><p>{status.enabled ? "Limits enabled" : "No local caps configured"}. Effective period: {status.day}; month starts {status.month}. Managed settings can override saved user values.</p>
      <table aria-label="Effective spend limits"><thead><tr><th>Scope</th><th>Period</th><th>Used estimate</th><th>Cap</th><th>Remaining</th><th>Status</th></tr></thead><tbody>{status.rows.map((r, i) => <tr key={i}><th>{r.model ?? "Overall"}</th><td>{r.period}</td><td>{r.spentUsd === null ? "Unknown" : `$${r.spentUsd.toFixed(6)}`}</td><td>${r.capUsd}</td><td>{r.remainingUsd === null ? "Unknown" : `$${r.remainingUsd.toFixed(6)}`}</td><td>{r.status}</td></tr>)}</tbody></table>
      <p>{status.basis} {status.coverage && `${status.coverage.undatedExcluded} undated observations excluded; ${status.coverage.skippedLines} malformed transcript lines skipped; ${status.coverage.legacyForks} uncertain legacy forks.`}</p></>}
  </section>;
}
