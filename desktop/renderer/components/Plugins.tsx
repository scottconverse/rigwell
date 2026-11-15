import { useEffect, useState } from "react";
import type { PluginService } from "../../../src/plugins/service.ts";
import type { Marketplace, PluginRecord } from "../../../src/plugins/store.ts";
import { app } from "../lib/app-model.ts";
import { ConfirmDialog, Dialog } from "./Dialogs.tsx";
type Preview = Awaited<ReturnType<PluginService["preview"]>>;

export function Plugins() {
  const [plugins, setPlugins] = useState<(PluginRecord & { intact: boolean })[]>([]), [indexes, setIndexes] = useState<Marketplace[]>([]);
  const [source, setSource] = useState(""), [commit, setCommit] = useState(""), [subdir, setSubdir] = useState(""), [updating, setUpdating] = useState<string>();
  const [indexName, setIndexName] = useState(""), [indexFile, setIndexFile] = useState("rigwell-marketplace.json");
  const [preview, setPreview] = useState<Preview>(), [removing, setRemoving] = useState<string>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const refresh = async () => { const r = await app.request("list_plugins"); setPlugins(r.plugins); setIndexes(r.indexes); };
  useEffect(() => { void refresh().catch((e) => setError(e.message)); }, []);
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setError(""); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const config = () => ({ source: source.trim(), ...(commit.trim() ? { commit: commit.trim() } : {}), ...(subdir.trim() ? { subdir: subdir.trim() } : {}) });
  const cancel = () => { const p = preview; setPreview(undefined); if (p) void app.request("cancel_plugin_preview", { token: p.token }).catch(() => {}); };
  useEffect(() => () => { if (preview) void app.request("cancel_plugin_preview", { token: preview.token }).catch(() => {}); }, [preview?.token]);
  return <section className="page"><h1>Plugins</h1><p>Plugins can add instructions and executable hooks or MCP servers. Inspect every addition before trusting a snapshot. Changes apply to new sessions; existing sessions retain their loaded tools.</p>
    {error && <p role="alert">{error}</p>}
    <h2>{updating ? `Update ${updating}` : "Install a plugin"}</h2>
    <label>Plugin source<input aria-label="Plugin source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Local folder or HTTPS/SSH Git URL" /></label>
    <label>Pinned commit<input aria-label="Plugin commit" value={commit} onChange={(e) => setCommit(e.target.value)} placeholder="Full commit SHA, required for Git URLs" /></label>
    <label>Source subfolder<input aria-label="Plugin subfolder" value={subdir} onChange={(e) => setSubdir(e.target.value)} /></label>
    <button disabled={busy || !source.trim()} onClick={() => void run(async () => setPreview(await app.request("preview_plugin", { source: config(), ...(updating ? { updating } : {}) })))}>Preview {updating ? "update" : "installation"}</button>
    {updating && <button onClick={() => { setUpdating(undefined); setSource(""); setCommit(""); setSubdir(""); }}>Cancel update</button>}
    <h2>Installed plugins</h2>{!plugins.length && <p>No plugins installed.</p>}
    <ul aria-label="Installed plugins">{plugins.map((p) => <li key={p.name}><h3>{p.name} {p.manifest.version}</h3><p>{p.manifest.description}</p><p>{p.enabled ? "Enabled" : "Disabled"}{!p.intact ? "; assets changed or missing, excluded from new sessions" : ""}</p><code>{p.source.commit ?? p.digest}</code>
      <button disabled={busy} onClick={() => void run(async () => { if (p.enabled) { await app.request("disable_plugin", { name: p.name }); await refresh(); } else setPreview(await app.request("enable_plugin_preview", { name: p.name })); })}>{p.enabled ? "Disable" : "Enable"} {p.name}</button>
      <button disabled={busy} onClick={() => { setUpdating(p.name); setSource(p.source.source); setCommit(p.source.commit ?? ""); setSubdir(p.source.subdir ?? ""); }}>Update {p.name}</button>
      <button disabled={busy} onClick={() => setRemoving(p.name)}>Uninstall {p.name}</button>
    </li>)}</ul>
    <h2>Marketplace indexes</h2><p>No index is included by default. Add a local checkout or a pinned Git repository using the source fields above. An index is inert data; each plugin still requires its own preview and trust.</p>
    <label>Index name<input aria-label="Marketplace name" value={indexName} onChange={(e) => setIndexName(e.target.value)} /></label>
    <label>Index file<input aria-label="Marketplace file" value={indexFile} onChange={(e) => setIndexFile(e.target.value)} /></label>
    <button disabled={busy || !source.trim() || !indexName.trim()} onClick={() => void run(async () => { await app.request("add_plugin_index", { name: indexName.trim(), source: config(), file: indexFile }); await refresh(); })}>Add or refresh index</button>
    {!indexes.length && <p>No marketplace indexes configured.</p>}
    {indexes.map((i) => <section key={i.name} aria-label={`Marketplace ${i.name}`}><h3>{i.name}</h3><button disabled={busy} onClick={() => void run(async () => { await app.request("remove_plugin_index", { name: i.name }); await refresh(); })}>Remove index {i.name}</button><ul>{i.plugins.map((p) => <li key={p.name}>{p.name}: {p.description}<code>{p.commit}</code><button disabled={busy} onClick={() => void run(async () => setPreview(await app.request("preview_index_plugin", { index: i.name, name: p.name })))}>Preview {p.name}</button></li>)}</ul></section>)}
    {preview && <Dialog title={`Trust plugin ${preview.manifest.name}?`} onClose={cancel} wide><p>{preview.manifest.description}</p><p>Version {preview.manifest.version}. Snapshot <code>{preview.digest}</code>.</p><p>{preview.needsTrust ? "This plugin adds executable hooks or MCP servers. Trusting allows them in new sessions." : "This plugin adds the instructions and templates below."}</p><ul aria-label="Plugin additions">{preview.additions.map((a, i) => <li key={i}><strong>{a.kind}: {a.name}</strong><pre>{JSON.stringify(a.detail, null, 2)}</pre></li>)}</ul><button disabled={busy} onClick={cancel}>Cancel</button><button disabled={busy} onClick={() => void run(async () => { await app.request("commit_plugin", { token: preview.token, confirmed: true }); setPreview(undefined); setUpdating(undefined); setSource(""); setCommit(""); setSubdir(""); await refresh(); })}>Trust and install</button></Dialog>}
    {removing && <ConfirmDialog title={`Uninstall ${removing}?`} body="Disable the plugin and remove its managed snapshots. Existing sessions may still have loaded tools; close them before removing a plugin they use." action="Uninstall plugin" onCancel={() => setRemoving(undefined)} onConfirm={() => void run(async () => { await app.request("uninstall_plugin", { name: removing, confirmed: true }); setRemoving(undefined); await refresh(); })} />}
  </section>;
}
