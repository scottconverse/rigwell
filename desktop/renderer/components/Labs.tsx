import { useEffect, useState } from "react";
import { app } from "../lib/app-model.ts";
import type { readFeatures } from "../../../src/features/features.ts";
import type { FeatureId } from "../../../src/features/config.ts";

export function Labs() {
  const [status, setStatus] = useState<ReturnType<typeof readFeatures>>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: FeatureId; enabled: boolean }>();
  const refresh = async () => setStatus(await app.request("get_features"));
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const save = async (id: FeatureId, enabled?: boolean) => {
    if (!status) return; setBusy(true); setError(""); if (enabled !== undefined) setPending({ id, enabled });
    try { const features = { ...status.configured }; if (enabled === undefined) delete features[id]; else features[id] = enabled; await app.updateUserSettings({ features }); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setPending(undefined); setBusy(false); }
  };
  return <><h2>Labs</h2><p>Experimental opt-ins default off. Earlier explicit session or repository opt-ins remain compatible until this map overrides them. Core features and the selected model/provider are unchanged. These settings apply only to this local profile; managed settings can override saved values.</p>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void refresh().catch((e) => setError(e.message))}>Refresh Labs</button>
    {status?.features.map((f) => <section key={f.id} aria-label={f.name}><label><input type="checkbox" aria-label={f.name} disabled={busy} checked={pending?.id === f.id ? pending.enabled : f.enabled} onChange={(e) => void save(f.id, e.target.checked)} />{f.name}</label><p>{f.description}</p><p>Effective local configuration: {f.enabled ? "on" : "off"}; source: {f.source}. ID: {f.id}</p><button disabled={busy || status.configured[f.id] === undefined} onClick={() => void save(f.id)}>Use default for {f.name}</button></section>)}
    <p>Enabling does not start agents or run a model. Existing policy, permission, budget and tool limits still apply. Restart or resume a session engine to apply its Script setting; nested Workstream disabling also checks at new control calls.</p>
  </>;
}
