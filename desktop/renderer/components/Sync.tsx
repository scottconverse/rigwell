import { useEffect, useState } from "react";
import { SETTING_KEYS, SYNC_KINDS } from "../../../src/sync/options.ts";
import type { SyncConfig } from "../../../src/sync/config.ts";
import type { SyncItem } from "../../../src/sync/target.ts";
import { app } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { SessionController } from "../lib/session.ts";
import { live } from "./SessionScreen.tsx";

type Summary = Omit<SyncItem, "files">;
export function Sync({ go }: { go(route: string): void }) {
  const [config, setConfig] = useState<SyncConfig>(), [kind, setKind] = useState("folder"), [destination, setDestination] = useState(""), [replicated, setReplicated] = useState(false), [privateGit, setPrivateGit] = useState(false), [authority, setAuthority] = useState(false), [leaseKind, setLeaseKind] = useState("folder"), [leasePath, setLeasePath] = useState("");
  const [kinds, setKinds] = useState<string[]>(["session", "automation", "mission", "workstream"]), [settings, setSettings] = useState<string[]>([]), [items, setItems] = useState<Summary[]>([]), [conflicts, setConflicts] = useState<Summary[]>([]), [lastSync, setLastSync] = useState<number>();
  const [view, setView] = useState<SyncItem>(), [restoring, setRestoring] = useState<Summary>(), [cwd, setCwd] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const apply = (r: any, configure = false) => {
    setConfig(r.config); setItems(r.items ?? []); setConflicts(r.conflicts ?? []); setLastSync(r.lastSync);
    if (configure && r.config) {
      const c: SyncConfig = r.config; setKind(c.target.kind); setDestination(c.target.kind === "folder" ? c.target.path : c.target.remote); setReplicated(c.target.kind === "folder" && !!c.target.replicated); setAuthority(!!c.folderIsAuthority); setPrivateGit(c.target.kind === "git"); setKinds(c.kinds); setSettings(c.settings);
      setLeaseKind(c.leaseTarget?.kind ?? "folder"); setLeasePath(c.leaseTarget ? c.leaseTarget.kind === "folder" ? c.leaseTarget.path : c.leaseTarget.remote : "");
    }
  };
  const run = async (action: () => Promise<void>) => { setError(""); setBusy(true); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { void run(async () => apply(await app.request("sync_status"), true)); }, []);
  const toggle = (list: string[], name: string) => list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
  const target = (type: string, value: string) => type === "folder" ? { kind: "folder", path: value } : { kind: "git", remote: value, private: privateGit };
  const row = (i: Summary) => <article className="card" key={`${i.key}-${i.hash}`}><h3>{i.key}</h3><p>Owner: {i.owner}</p><p>Revision: {i.hash.slice(0, 12)}</p>
    <button disabled={busy} onClick={() => void run(async () => setView((await app.request("sync_view", { key: i.key, hash: i.hash })).item))}>View {i.key}</button>
    <button disabled={busy || !config || (i.key.startsWith("session/") && !cwd)} onClick={() => setRestoring(i)}>Restore {i.key}</button></article>;
  return <div className="page" aria-label="Sync page"><h1>Sync between machines</h1>
    <p>Sync is {config ? "configured" : "off"}. Credentials and secrets are excluded. Incoming copies stay read-only until you restore them. Restored jobs remain paused.</p>
    {lastSync && <p>Last sync: {new Date(lastSync).toLocaleString()}</p>}
    {error && <div role="alert" className="banner error">{error}</div>}
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => apply(await app.request("sync_configure", { config: { version: 1, target: { ...target(kind, destination), ...(kind === "folder" && replicated ? { replicated: true } : {}) }, kinds, settings, folderIsAuthority: authority, ...(leasePath ? { leaseTarget: target(leaseKind, leasePath) } : {}) } }))); }}>
      <label>Sync target<select aria-label="Sync target" value={kind} onChange={(e) => setKind(e.target.value)}><option value="folder">Folder</option><option value="git">Private git remote</option></select></label>
      <label>Destination<input required aria-label="Sync destination" value={destination} onChange={(e) => setDestination(e.target.value)} /></label>
      {kind === "folder" && <><button disabled={busy} type="button" onClick={() => void run(async () => { const folder = await bridge().dialog.pickFolder(); if (folder) setDestination(folder); })}>Choose sync folder</button>
        <label><input type="checkbox" checked={replicated} onChange={(e) => { setReplicated(e.target.checked); setAuthority(false); }} />This folder is replicated asynchronously</label>
        {!replicated && <label><input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} />All machines access this same authoritative filesystem</label>}</>}
      {(kind === "git" || replicated || leaseKind === "git") && <label><input type="checkbox" checked={privateGit} onChange={(e) => setPrivateGit(e.target.checked)} />I have verified that the git remote is private</label>}
      {replicated && <><p>A replicated folder cannot arbitrate session ownership. Choose one reachable authority used by every machine.</p>
        <label>Lease authority<select aria-label="Lease authority" value={leaseKind} onChange={(e) => setLeaseKind(e.target.value)}><option value="folder">Shared filesystem</option><option value="git">Private git remote</option></select></label>
        <label>Lease destination<input required aria-label="Lease destination" value={leasePath} onChange={(e) => setLeasePath(e.target.value)} /></label></>}
      <fieldset><legend>Items to sync</legend>{SYNC_KINDS.map((name) => <label key={name}><input type="checkbox" checked={kinds.includes(name)} onChange={() => setKinds(toggle(kinds, name))} />{name}</label>)}</fieldset>
      {kinds.includes("settings") && <fieldset><legend>Settings to sync</legend>{SETTING_KEYS.map((name) => <label key={name}><input type="checkbox" checked={settings.includes(name)} onChange={() => setSettings(toggle(settings, name))} />{name}</label>)}</fieldset>}
      <button disabled={busy}>Save sync configuration</button>
    </form>
    <button disabled={busy || !config} onClick={() => void run(async () => apply(await app.request("sync_now")))}>Sync now</button>
    <button disabled={busy || !config} onClick={() => void run(async () => apply(await app.request("sync_configure", { config: null })))}>Turn sync off</button>
    <label>Working folder for restored sessions<input aria-label="Sync working folder" value={cwd} onChange={(e) => setCwd(e.target.value)} /></label><h2>Synced items</h2>{items.map(row)}<h2>Conflicting copies</h2>{conflicts.map(row)}
    {view && <section aria-label="Read-only synced copy"><h2>{view.key}</h2><p>Read-only</p>{Object.entries(view.files).map(([name, content]) => <article key={name}><h3>{name}</h3><pre className="pre">{content}</pre></article>)}</section>}
    {restoring && <ConfirmDialog title="Restore synced copy?" action="Restore and keep backup" body="Transfer ownership to this machine. Existing files are backed up. Automations, missions and Workstreams remain paused; review their workspace before resuming." onCancel={() => setRestoring(undefined)} onConfirm={() => { const item = restoring; setRestoring(undefined); void run(async () => { const r = await app.request("sync_restore", { key: item.key, hash: item.hash, ...(cwd ? { cwd } : {}) }); apply(await app.request("sync_status")); if (r.sessionId) { const ctl = await SessionController.resume(r.sessionId, cwd); live.set(r.sessionId, ctl); await app.refresh(); go(`/sessions/${r.sessionId}`); } }); }} />}
  </div>;
}
