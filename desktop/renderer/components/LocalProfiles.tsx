import { useEffect, useState } from "react";
import type { LocalProfile } from "../../../src/storage/local-profiles.ts";
import { bridge } from "../lib/rpc.ts";

export function LocalProfiles() {
  const [rows, setRows] = useState<LocalProfile[]>([]), [active, setActive] = useState(""), [id, setId] = useState(""), [name, setName] = useState(""), [role, setRole] = useState(""), [currentName, setCurrentName] = useState(""), [currentRole, setCurrentRole] = useState(""), [target, setTarget] = useState(""), [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const refresh = async () => { const value = await bridge().localProfiles.list(); setActive(value.active); setRows(value.profiles); const current = value.profiles.find((p) => p.id === value.active); setCurrentName(current?.name ?? ""); setCurrentRole(current?.role ?? ""); };
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const act = async (run: () => Promise<unknown>) => { setBusy(true); setError(""); setNote(""); try { await run(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <><h2>Local profiles</h2><p>Each profile has separate Rigwell settings, stored credentials, sessions and index, daemon connection, automations and other local data. Profiles share repository files, the Windows/macOS/Linux user, environment variables and official subscription-client logins. They are not an operating-system security boundary. Base and system policy still apply.</p>
    {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}
    <p>Active profile: <strong>{active}</strong></p>
    <label>Profile name<input aria-label="Profile name" value={currentName} onChange={(e) => setCurrentName(e.target.value)} /></label><label>Role<input aria-label="Role" value={currentRole} onChange={(e) => setCurrentRole(e.target.value)} /></label><p>Role is a local descriptive label, not an authorization setting.</p>
    <button disabled={busy || !active} onClick={() => void act(async () => { await bridge().localProfiles.update(active, currentName, currentRole); await refresh(); setNote("Profile details saved"); })}>Save profile details</button>
    <table aria-label="Local profiles"><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Switch</th></tr></thead><tbody>{rows.map((p) => <tr key={p.id}><td>{p.id}</td><td>{p.name}</td><td>{p.role || "None"}</td><td>{p.id === active ? "Active" : <button disabled={busy} aria-label={`Switch to ${p.id}`} onClick={() => setTarget(p.id)}>Switch</button>}</td></tr>)}</tbody></table>
    {target && <section role="dialog" aria-label="Confirm profile switch"><p>Restart Rigwell and switch to {target}? Current agent and background work will stop. Saved sessions remain in their original profile; interrupted work is not automatically restarted.</p><button disabled={busy} onClick={() => setTarget("")}>Cancel switch</button><button disabled={busy} onClick={() => void act(async () => { const result = await bridge().localProfiles.switch(target, true); setTarget(""); setNote(result.restarting ? "Restarting with selected profile" : "This profile is already active"); })}>Restart and switch</button></section>}
    <h3>Create a profile</h3><label>New profile ID<input aria-label="New profile ID" value={id} onChange={(e) => setId(e.target.value)} /></label><label>New profile name<input aria-label="New profile name" value={name} onChange={(e) => setName(e.target.value)} /></label><label>New profile role<input aria-label="New profile role" value={role} onChange={(e) => setRole(e.target.value)} /></label>
    <button disabled={busy} onClick={() => void act(async () => { await bridge().localProfiles.create(id.trim(), name.trim() || id.trim(), role.trim()); await refresh(); setId(""); setName(""); setRole(""); setNote("Profile created with empty settings and credentials"); })}>Create profile</button>
  </>;
}
