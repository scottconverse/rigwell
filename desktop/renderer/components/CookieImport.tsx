// Chrome cookie import into the browser pane (spec 17.3, owner approved). Explicit user action only: the user picks a
// profile, then the sites; only those sites' cookies are copied into the pane's session. Values never reach this page.
import { useEffect, useState } from "react";
import { filterDomains, importSummary } from "../lib/access.ts";
import { bridge } from "../lib/rpc.ts";
import { Dialog } from "./Dialogs.tsx";

type Profile = { key: string; browser: string; name: string; dir: string };

export function CookieImportDialog({ onClose }: { onClose(): void }) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profile, setProfile] = useState("");
  const [domains, setDomains] = useState<{ domain: string; count: number }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void bridge().cookies.profiles().then((p) => { setProfiles(p); if (p[0]) setProfile(p[0].key); }, (e) => setError((e as Error).message)); }, []);

  const load = async () => {
    setError(""); setBusy(true);
    try { setDomains(await bridge().cookies.domains(profile)); setPicked(new Set()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const run = async () => {
    setError(""); setBusy(true);
    try { setResult(importSummary(await bridge().cookies.import(profile, [...picked]))); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const shown = domains ? filterDomains(domains, q) : [];
  const toggle = (d: string) => setPicked((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  return (
    <Dialog title="Import cookies from Chrome" onClose={onClose} wide>
      <p className="muted small">Copies the cookies of the sites you choose from a Chrome or Chromium profile into this browser pane, so you stay signed in. Only the chosen sites are read, nothing is sent anywhere, and cookie values are never shown or logged. On macOS the system may ask to allow access to "Chrome Safe Storage".</p>
      {error && <div className="error-text" role="alert">{error}</div>}
      {result ? <div className="banner small" role="status">{result}</div> : null}
      {profiles && !profiles.length && <div className="muted">No Chrome or Chromium profile was found on this computer.</div>}
      {profiles && profiles.length > 0 && (
        <div className="dlg-row">
          <select aria-label="Chrome profile" value={profile} onChange={(e) => { setProfile(e.target.value); setDomains(null); setResult(""); }}>
            {profiles.map((p) => <option key={p.key} value={p.key}>{p.browser === "chromium" ? "Chromium" : "Chrome"}: {p.name}</option>)}
          </select>
          <button disabled={busy} onClick={() => void load()}>Show sites</button>
        </div>
      )}
      {domains && (
        <>
          <input aria-label="Filter sites" placeholder="Filter sites" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="cookie-list" role="group" aria-label="Sites">
            {shown.map((d) => <label className="check" key={d.domain}><input type="checkbox" checked={picked.has(d.domain)} onChange={() => toggle(d.domain)} />{d.domain} <span className="muted small">({d.count})</span></label>)}
            {!shown.length && <div className="muted small">No sites match.</div>}
          </div>
        </>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={busy || !picked.size} onClick={() => void run()}>Import {picked.size ? `${picked.size} site${picked.size === 1 ? "" : "s"}` : "cookies"}</button>
      </div>
    </Dialog>
  );
}
