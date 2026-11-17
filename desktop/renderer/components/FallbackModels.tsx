import { useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { parseFallbackModels } from "../../../src/agent/fallback-config.ts";

export function FallbackModels() {
  const a = useApp(), [text, setText] = useState<string>(() => (a.userSettings.fallbackModels ?? []).join("\n")), [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(""); setNote("");
    try { const ids = parseFallbackModels(text.split(/\r?\n/).map((id) => id.trim()).filter(Boolean)); await app.updateUserSettings({ fallbackModels: ids }); setText(ids.join("\n")); setNote("Fallback list saved for new or resumed session engines. Managed settings can override it."); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section aria-label="Fallback models"><h3>Fallback models</h3><p>Exact profile IDs, one per line, in order. After a model exhausts its normal retries or reaches its profile cap, answers and summaries try this list. Empty disables the extra pool. Auto routing keeps its scored candidates first. Overall caps, cancellation and policy restrictions still apply. These profiles may receive the conversation and use their configured tools.</p>
    <label>Ordered fallback profile IDs<textarea aria-label="Ordered fallback profile IDs" value={text} onChange={(e) => setText(e.target.value)} /></label>
    <button disabled={busy} onClick={() => void save()}>Save fallback models</button>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
    <p>Available IDs: {a.models.map((m) => m.id).join(", ") || "See Custom Models for configured profile IDs"}. Unavailable or policy-blocked entries are skipped; no account or provider is added automatically.</p>
  </section>;
}
