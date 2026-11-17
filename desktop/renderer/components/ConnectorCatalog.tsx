import { useEffect, useState } from "react";
import type { CatalogRow } from "../../../src/mcp/catalog.ts";
import { app, useStore } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";

export function ConnectorCatalog({ request, busy, onAdd }: {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  busy: boolean; onAdd(p: Record<string, unknown>): Promise<void>;
}) {
  const state = useStore(app);
  const saved = Array.isArray(state.userSettings.mcpCatalogUrls) ? state.userSettings.mcpCatalogUrls as string[] : [];
  const [sources, setSources] = useState(saved.join("\n"));
  const [rows, setRows] = useState<CatalogRow[]>([]), [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState(""), [category, setCategory] = useState("");
  const [selected, setSelected] = useState<CatalogRow>(), [values, setValues] = useState<Record<string, string>>({}), [name, setName] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    void request("mcp_catalog_list", { sources: saved }).then((r) => { if (!stopped) { setRows(r.entries); setWarnings(r.warnings); } }).catch((e) => { if (!stopped) setError(e.message); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [request]);
  const add = async (row: CatalogRow) => {
    if (row.inputs?.length) { setSelected(row); setName(row.name); setValues({}); }
    else await onAdd({ key: row.key });
  };
  return <section aria-label="Connector catalog">
    <div className="dlg-row">
      <input aria-label="Search catalog" placeholder="Search catalog" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Catalog category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{[...new Set(rows.map((r) => r.category))].sort().map((c) => <option key={c}>{c}</option>)}</select>
    </div>
    {loading && <p role="status">Loading catalog</p>}
    {error && <p role="alert">{error}</p>}
    {warnings.map((w) => <p className="error-text small" key={w}>{w}</p>)}
    <ul className="plain-list">{rows.filter((r) => (!category || r.category === category) && `${r.name} ${r.description}`.toLowerCase().includes(query.toLowerCase())).map((r) => <li className="pad" key={r.key}>
      <b>{r.name}</b> <span className="muted small">{r.category} / {r.auth}</span><p>{r.description}</p>
      <p className="mono-line">{r.url ?? [r.command, ...(r.args ?? [])].join(" ")}</p>
      <span className="small muted">Source: {r.source}</span>{" "}
      <a href={r.docs} onClick={(e) => { e.preventDefault(); void bridge().shell.openExternal(r.docs); }}>Documentation</a>{" "}
      <button disabled={busy} aria-label={`Add ${r.name}`} onClick={() => void add(r)}>Add</button>
    </li>)}</ul>
    {selected && <form aria-label="Connector values" onSubmit={(e) => { e.preventDefault(); const params = { key: selected.key, name, values }; setValues({}); setSelected(undefined); void onAdd(params); }}>
      <h4>Add {selected.name}</h4>
      <label className="field">Server name<input aria-label="Catalog server name" required value={name} onChange={(e) => setName(e.target.value)} /></label>
      {selected.inputs?.map((i) => <label className="field" key={i.name}>{i.label}<input aria-label={i.label} type={i.secret ? "password" : "text"} required autoComplete="off" value={values[i.name] ?? ""} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} /></label>)}
      <button className="primary" disabled={busy}>Add connector</button>{" "}<button type="button" onClick={() => { setSelected(undefined); setValues({}); }}>Cancel</button>
    </form>}
    <label className="field">Additional catalog URLs or JSON file paths<textarea aria-label="Catalog sources" value={sources} onChange={(e) => setSources(e.target.value)} placeholder="One source per line" /></label>
    <button onClick={() => { void app.updateUserSettings({ mcpCatalogUrls: sources.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }).then(() => setError("Saved. Reopen Catalog to load these sources."), (e) => setError(e.message)); }}>Save catalog sources</button>
  </section>;
}
