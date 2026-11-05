// Settings pages for the agent (spec §14.3): Session Defaults, Missions, Custom Models, Worktrees, Connectors,
// Session Management and Usage. These edit the user settings file through the main process (secrets stay masked).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { MASK, PROVIDERS, emptyForm, keyHint, toEntry, toForm, validate, type ModelForm } from "../lib/custom-models.ts";
import { DaemonConn, bridge } from "../lib/rpc.ts";
import { bulkRename, managementRows, projectName, type SessionRow } from "../lib/sessions.ts";
import { prChip, prRequestHandler, type PrDetails, type PrStatusResult } from "../lib/pr.ts";
import { addUsage, fmt, percentUsed, total, zero, type TokenUsage } from "../lib/usage.ts";
import { ManagedNote, OrgCeiling } from "./SettingsAccess.tsx";
import { AddServerForm, Dialog, McpLoginPanel, ServerList, TextDialog, useMcp } from "./Dialogs.tsx";

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="row"><div className="row-label"><div>{label}</div>{hint && <div className="muted small">{hint}</div>}</div><div className="row-ctl">{children}</div></div>
);
const EFFORTS = ["off", "low", "medium", "high"];

/** Saves one top-level user setting and shows a short confirmation. */
function useSave() {
  const [note, setNote] = useState("");
  const save = async (patch: Record<string, unknown>) => {
    try { await app.updateUserSettings(patch); setNote("Saved"); } catch (e) { setNote((e as Error).message); }
    setTimeout(() => setNote(""), 1800);
  };
  return { note, save, status: note ? <span className="muted small" role="status">{note}</span> : null };
}

function ModelSelect({ value, onChange, label, allowNone, extra }: { value?: string; onChange(v: string): void; label: string; allowNone?: string; extra?: { id: string; label: string }[] }) {
  const a = useApp();
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {extra?.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      {a.models.map((m) => <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>)}
    </select>
  );
}

// ------------------------------------------------------------------ Session Defaults (spec §12.2)

export function SessionDefaults() {
  const a = useApp();
  const u = a.userSettings;
  const d = (u.sessionDefaultSettings ?? {}) as Record<string, string>;
  const { save, status } = useSave();
  const set = (k: string, v: string) => void save({ sessionDefaultSettings: { ...d, ...(v ? { [k]: v } : {}), ...(v ? {} : { [k]: undefined }) } });
  const limit = typeof u.compactionTokenLimit === "number" ? String(u.compactionTokenLimit) : "";
  const [limitText, setLimitText] = useState(limit);
  useEffect(() => setLimitText(limit), [limit]);
  const limitOk = limitText === "" || (/^\d+$/.test(limitText) && Number(limitText) >= 100_000 && Number(limitText) <= 1_000_000);
  const auto = a.userSettings.autoRouter ? [{ id: "auto", label: "Auto" }] : [];
  return (
    <>
      <h2>Session Defaults {status} <ManagedNote keys={["sessionDefaultSettings", "compactionTokenLimit", "compactionModel", "specSaveDir"]} /></h2>
      <OrgCeiling />
      <Row label="Model" hint="Used for new sessions"><ModelSelect label="Default model" value={d.model} onChange={(v) => set("model", v)} allowNone="First available" extra={auto} /></Row>
      <Row label="Reasoning"><select aria-label="Default reasoning" value={d.reasoningEffort ?? "high"} onChange={(e) => set("reasoningEffort", e.target.value)}>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select></Row>
      <Row label="Mode"><select aria-label="Default mode" value={d.interactionMode ?? "auto"} onChange={(e) => set("interactionMode", e.target.value)}><option value="auto">Auto</option><option value="spec">Spec</option></select></Row>
      <Row label="Autonomy" hint="Off asks before every edit and command"><select aria-label="Default autonomy" value={d.autonomyLevel ?? "off"} onChange={(e) => set("autonomyLevel", e.target.value)}>{["off", "low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}</select></Row>
      <h3>Spec mode</h3>
      <Row label="Spec model"><ModelSelect label="Spec model" value={d.specModeModel} onChange={(v) => set("specModeModel", v)} allowNone="Same as session" /></Row>
      <Row label="Spec reasoning"><select aria-label="Spec reasoning" value={d.specModeReasoningEffort ?? ""} onChange={(e) => set("specModeReasoningEffort", e.target.value)}><option value="">Same as session</option>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select></Row>
      <Row label="Save specs in" hint="A folder path; empty uses the project"><input aria-label="Spec folder" defaultValue={typeof u.specSaveDir === "string" ? u.specSaveDir : ""} onBlur={(e) => void save({ specSaveDir: e.target.value.trim() || null })} /></Row>
      <h3>Compaction</h3>
      <Row label="Token limit" hint="100000 to 1000000"><input aria-label="Compaction token limit" inputMode="numeric" value={limitText} aria-invalid={!limitOk} onChange={(e) => setLimitText(e.target.value)} onBlur={() => { if (limitOk) void save({ compactionTokenLimit: limitText === "" ? null : Number(limitText) }); }} />{!limitOk && <span className="error-text small" role="alert">Enter a number from 100000 to 1000000</span>}</Row>
      <Row label="Compaction model"><ModelSelect label="Compaction model" value={u.compactionModel} onChange={(v) => void save({ compactionModel: v || null })} allowNone="Same as session" /></Row>
      <Row label="Check threshold" hint="Compact automatically when the limit is near"><input type="checkbox" aria-label="Compaction threshold check" checked={u.compactionThresholdCheckEnabled !== false} onChange={(e) => void save({ compactionThresholdCheckEnabled: e.target.checked })} /></Row>
    </>
  );
}

// ------------------------------------------------------------------ Missions (spec §15.4)

export function MissionSettings() {
  const a = useApp();
  const m = (a.userSettings.missions ?? {}) as Record<string, any>;
  const { save, status } = useSave();
  const set = (k: string, v: unknown) => { const next = { ...m }; if (v === "" || v === undefined || v === false) delete next[k]; else next[k] = v; void save({ missions: next }); };
  const allowed: string[] = m.allowedModels ?? [];
  const eff = (k: string, label: string) => (
    <select aria-label={label} value={m[k] ?? ""} onChange={(e) => set(k, e.target.value)}><option value="">Same as model</option>{EFFORTS.map((x) => <option key={x}>{x}</option>)}</select>
  );
  return (
    <>
      <h2>Missions {status} <ManagedNote keys={["missions"]} /></h2>
      <p className="muted">Models for each role. Changes apply to the next mission you enter.</p>
      <h3>Orchestrator</h3>
      <Row label="Model" hint="Used when the current model is not on the allowed list"><ModelSelect label="Orchestrator model" value={m.orchestratorModel} onChange={(v) => set("orchestratorModel", v)} allowNone="Keep current" /></Row>
      <Row label="Reasoning">{eff("orchestratorReasoningEffort", "Orchestrator reasoning")}</Row>
      <h3>Worker</h3>
      <Row label="Model"><ModelSelect label="Worker model" value={m.workerModel} onChange={(v) => set("workerModel", v)} allowNone="Same as orchestrator" /></Row>
      <Row label="Reasoning">{eff("workerReasoningEffort", "Worker reasoning")}</Row>
      <h3>Validator</h3>
      <Row label="Model"><ModelSelect label="Validator model" value={m.validationWorkerModel} onChange={(v) => set("validationWorkerModel", v)} allowNone="Same as worker" /></Row>
      <Row label="Reasoning">{eff("validationWorkerReasoningEffort", "Validator reasoning")}</Row>
      <Row label="Skip scrutiny validation"><input type="checkbox" aria-label="Skip scrutiny" checked={m.skipScrutiny === true} onChange={(e) => set("skipScrutiny", e.target.checked)} /></Row>
      <Row label="Skip user-testing validation"><input type="checkbox" aria-label="Skip user testing" checked={m.skipUserTesting === true} onChange={(e) => set("skipUserTesting", e.target.checked)} /></Row>
      <h3>Allowed orchestrator models</h3>
      <p className="muted small">Leave all unchecked to allow any model.</p>
      <div className="checklist">
        {a.models.map((x) => <label key={x.id} className="check"><input type="checkbox" checked={allowed.includes(x.id)} onChange={(e) => set("allowedModels", e.target.checked ? [...allowed, x.id] : allowed.filter((i) => i !== x.id))} />{x.displayName ?? x.id}</label>)}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Custom Models (spec §4.6)

export function CustomModels() {
  const a = useApp();
  const list: Record<string, any>[] = Array.isArray(a.userSettings.customModels) ? a.userSettings.customModels : [];
  const { save, status } = useSave();
  const [editing, setEditing] = useState<{ index: number; form: ModelForm } | null>(null);
  const [error, setError] = useState("");
  const f = editing?.form;
  const set = (p: Partial<ModelForm>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...p } } : e));
  const commit = async () => {
    if (!editing) return;
    const bad = validate(editing.form);
    if (bad) { setError(bad); return; }
    const next = list.slice();
    next[editing.index < 0 ? next.length : editing.index] = toEntry(editing.form);
    await save({ customModels: next });
    setEditing(null); setError("");
    void app.refresh();
  };
  return (
    <>
      <h2>Custom Models {status} <ManagedNote keys={["customModels", "modelPolicy"]} /></h2>
      <p className="muted">Use your own provider keys. Keys are stored in the settings file and are never shown again after saving.</p>
      <ul className="plain-list" aria-label="Custom models">
        {list.map((m, i) => (
          <li key={i} className="srv">
            <span className="srv-name">{m.displayName ?? m.model}</span>
            <span className="muted small">{m.provider} / {m.baseUrl} / {keyHint(m.apiKey ?? "")}</span>
            <span className="spacer" />
            <button aria-label={`Edit ${m.displayName ?? m.model}`} onClick={() => { setEditing({ index: i, form: toForm(m) }); setError(""); }}>Edit</button>
            <button className="danger" aria-label={`Remove ${m.displayName ?? m.model}`} onClick={() => void save({ customModels: list.filter((_, j) => j !== i) }).then(() => app.refresh())}>Remove</button>
          </li>
        ))}
        {!list.length && <li className="muted pad">No custom models yet.</li>}
      </ul>
      <button className="primary" onClick={() => { setEditing({ index: -1, form: emptyForm() }); setError(""); }}>Add model</button>
      {editing && f && (
        <Dialog title={editing.index < 0 ? "Add custom model" : "Edit custom model"} onClose={() => setEditing(null)} wide>
          <label className="field"><span>Provider and API format</span>
            <select aria-label="Provider" value={f.provider} onChange={(e) => { const p = PROVIDERS.find((x) => x.id === e.target.value)!; set({ provider: p.id, baseUrl: !f.baseUrl || PROVIDERS.some((x) => x.baseUrl === f.baseUrl) ? p.baseUrl : f.baseUrl }); }}>{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label className="field"><span>Model name</span><input aria-label="Model name" value={f.model} onChange={(e) => set({ model: e.target.value })} /></label>
          <label className="field"><span>Display name</span><input aria-label="Display name" value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} /></label>
          <label className="field"><span>Base URL</span><input aria-label="Base URL" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} /></label>
          <label className="field"><span>API key</span><input type="password" autoComplete="off" aria-label="API key" placeholder={'Paste a key, or ${ENV_VAR}'} value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
            <span className="muted small">{f.apiKey.startsWith(MASK) ? "A key is saved. Leave this as it is to keep it." : keyHint(f.apiKey)}</span></label>
          <div className="dlg-row">
            <label className="field"><span>Max output tokens</span><input aria-label="Max output tokens" inputMode="numeric" value={f.maxOutputTokens} onChange={(e) => set({ maxOutputTokens: e.target.value })} /></label>
            <label className="field"><span>Context limit</span><input aria-label="Context limit" inputMode="numeric" value={f.maxContextLimit} onChange={(e) => set({ maxContextLimit: e.target.value })} /></label>
            <label className="field"><span>Reasoning</span><select aria-label="Model reasoning" value={f.reasoningEffort} onChange={(e) => set({ reasoningEffort: e.target.value })}><option value="">Default</option>{["off", "low", "medium", "high", "xhigh", "max"].map((x) => <option key={x}>{x}</option>)}</select></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.noImageSupport} onChange={(e) => set({ noImageSupport: e.target.checked })} />This model cannot read images</label>
          <div className="field"><span>Extra headers</span>
            {f.headers.map((h, i) => (
              <div key={i} className="dlg-row">
                <input aria-label="Header name" value={h.key} onChange={(e) => set({ headers: f.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                <input type="password" autoComplete="off" aria-label="Header value" value={h.value} onChange={(e) => set({ headers: f.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <button onClick={() => set({ headers: f.headers.filter((_, j) => j !== i) })} aria-label="Remove header">Remove</button>
              </div>
            ))}
            <button onClick={() => set({ headers: [...f.headers, { key: "", value: "" }] })}>Add header</button>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
          <div className="dialog-actions"><button onClick={() => setEditing(null)}>Cancel</button><button className="primary" onClick={() => void commit()}>Save</button></div>
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Worktrees (spec §18)

interface Managed { path: string; branch?: string; repoRoot?: string; lifecycle?: string; baseRef?: string; pr?: { number: number; url: string } }
interface Profile { id: string; source: string; name: string; script?: string; initialPrompt?: string; cleanupScript?: string }

export function WorktreeSettings() {
  const a = useApp();
  const u = a.userSettings;
  const { save, status } = useSave();
  const [dir, setDir] = useState(typeof u.worktreeDirectory === "string" ? u.worktreeDirectory : "");
  const [limit, setLimit] = useState(typeof u.worktreeAutoDeleteLimit === "number" ? String(u.worktreeAutoDeleteLimit) : "15");
  const dirOk = dir === "" || dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir);
  const limitOk = /^\d+$/.test(limit);
  const [managed, setManaged] = useState<Managed[]>([]);
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState<{ w: Managed; info: any } | null>(null);
  const [prs, setPrs] = useState<Record<string, PrStatusResult | null>>({});
  const [confirmPr, setConfirmPr] = useState<{ d: PrDetails; answer: (yes: boolean) => void } | null>(null);
  const [prBusy, setPrBusy] = useState("");
  // PR status for each row. A row whose status cannot be read (no gh, no token, no remote) shows no chip.
  const loadPrs = useCallback(async (rows: Managed[]) => {
    const pairs = await Promise.all(rows.map(async (w) => [w.path, await app.request<PrStatusResult>("get_pr_status", { worktreePath: w.path }).catch(() => null)] as const));
    setPrs(Object.fromEntries(pairs));
  }, []);
  const reload = useCallback(async () => {
    try { const rows: Managed[] = (await app.request("list_managed_worktrees")).worktrees ?? []; setManaged(rows); setErr(""); void loadPrs(rows); } catch (e) { setErr((e as Error).message); }
  }, [loadPrs]);
  // create_pr asks first (request_permission); the dialog below answers it. A short-lived connection carries the ask.
  const createPr = async (w: Managed) => {
    setPrBusy(w.path); setErr("");
    const c = await DaemonConn.open();
    c.onRequest = prRequestHandler((d) => new Promise<boolean>((answer) => setConfirmPr({ d, answer: (yes) => { setConfirmPr(null); answer(yes); } })));
    try {
      const r = await c.request("create_pr", { worktreePath: w.path });
      if (r.created) void reload();
    } catch (e) { setErr((e as Error).message); } finally { c.close(); setPrBusy(""); }
  };
  useEffect(() => { if (a.daemon.state === "running") void reload(); }, [reload, a.daemon.state]);

  const [folder, setFolder] = useState(a.recentFolders[0] ?? "");
  const [profiles, setProfiles] = useState<{ repoRoot: string | null; profiles: Profile[] }>({ repoRoot: null, profiles: [] });
  const [edit, setEdit] = useState<Profile | null>(null);
  const [perr, setPerr] = useState("");
  const loadProfiles = useCallback(async () => { if (folder) setProfiles(await bridge().profiles.list(folder)); }, [folder]);
  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  return (
    <>
      <h2>Worktrees {status} <ManagedNote keys={["runInWorktree", "worktrees"]} /></h2>
      <Row label="Run new sessions in a worktree" hint="The default for the Worktree toggle on Home"><input type="checkbox" aria-label="Run in worktree by default" checked={u.runInWorktree === true} onChange={(e) => void save({ runInWorktree: e.target.checked })} /></Row>
      <Row label="Folder" hint="An absolute path. Empty uses the Rigwell folder.">
        <input aria-label="Worktree folder" value={dir} aria-invalid={!dirOk} onChange={(e) => setDir(e.target.value)} onBlur={() => { if (dirOk) void save({ worktreeDirectory: dir.trim() || null }); }} />
        {!dirOk && <span className="error-text small" role="alert">Use an absolute path</span>}
      </Row>
      <Row label="Keep at most" hint="Older ephemeral worktrees are removed before a new one is made">
        <input aria-label="Ephemeral worktree limit" inputMode="numeric" value={limit} aria-invalid={!limitOk} onChange={(e) => setLimit(e.target.value)} onBlur={() => { if (limitOk) void save({ worktreeAutoDeleteLimit: Number(limit) }); }} />
      </Row>
      <h3>Managed worktrees</h3>
      {err && <div className="banner error" role="alert">{err}</div>}
      <ul className="plain-list" aria-label="Managed worktrees">
        {managed.map((w) => (
          <li key={w.path} className="srv"><span className="srv-name">{w.branch ?? projectName(w.path)}</span><span className="muted small mono">{w.path}</span><span className="spacer" />
            {(() => { const chip = prChip(prs[w.path]); return chip ? <a className={`badge pr-${chip.tone}`} href={prs[w.path]?.url} target="_blank" rel="noreferrer" aria-label={`Pull request for ${w.path}`}>{chip.text}</a> : null; })()}
            {(!prs[w.path] || prs[w.path]!.state === "none" || prs[w.path]!.state === "closed") && <button aria-label={`Create PR for ${w.path}`} disabled={prBusy === w.path} onClick={() => void createPr(w)}>{prBusy === w.path ? "Creating PR..." : "Create PR"}</button>}
            <button className="danger" aria-label={`Remove ${w.path}`} onClick={() => void app.request("inspect_worktree_deletion", { worktreePath: w.path }).then((info) => setRemoving({ w, info })).catch((e) => setErr(e.message))}>Remove</button></li>
        ))}
        {!managed.length && <li className="muted pad">No managed worktrees.</li>}
      </ul>
      {confirmPr && (
        <Dialog title="Push and create a pull request?" onClose={() => confirmPr.answer(false)}>
          <p className="mono-line">{confirmPr.d.branch} into {confirmPr.d.base}{confirmPr.d.remote ? ` on ${confirmPr.d.remote}` : ""}</p>
          <p><strong>{confirmPr.d.title}</strong></p>
          {confirmPr.d.body && <pre className="code-block small">{confirmPr.d.body}</pre>}
          <p className="muted small">This pushes the branch, then opens the pull request on GitHub.</p>
          <div className="dialog-actions"><button onClick={() => confirmPr.answer(false)}>Cancel</button>
            <button className="primary" onClick={() => confirmPr.answer(true)}>Push and create</button></div>
        </Dialog>
      )}
      {removing && (
        <Dialog title="Remove this worktree?" onClose={() => setRemoving(null)}>
          <p className="mono-line">{removing.w.path}</p>
          <pre className="code-block small">{JSON.stringify(removing.info, null, 2)}</pre>
          <div className="dialog-actions"><button onClick={() => setRemoving(null)}>Cancel</button>
            <button className="danger" onClick={() => void app.request("cleanup_worktree", { worktreePath: removing.w.path, force: true }).then(() => { setRemoving(null); void reload(); }).catch((e) => setErr(e.message))}>Remove</button></div>
        </Dialog>
      )}
      <h3>Setup profiles</h3>
      <p className="muted small">A profile prepares a new worktree: a setup script, a first prompt and a cleanup script. Profiles saved here are private to you; profiles in the repository are read only.</p>
      <Row label="Project"><select aria-label="Profile project" value={folder} onChange={(e) => setFolder(e.target.value)}>{a.recentFolders.map((f) => <option key={f} value={f}>{f}</option>)}</select></Row>
      {folder && !profiles.repoRoot && <div className="muted small">This folder is not a git repository.</div>}
      <ul className="plain-list" aria-label="Setup profiles">
        {profiles.profiles.map((p) => (
          <li key={`${p.source}-${p.id}`} className="srv"><span className="srv-name">{p.name}</span><span className="muted small">{p.source}</span><span className="spacer" />
            {p.source === "local" ? <><button onClick={() => { setEdit(p); setPerr(""); }}>Edit</button><button className="danger" aria-label={`Delete ${p.name}`} onClick={() => void bridge().profiles.remove(folder, p.id).then(loadProfiles)}>Delete</button></> : <span className="muted small">read only</span>}</li>
        ))}
        {profiles.repoRoot && !profiles.profiles.length && <li className="muted pad">No profiles for this repository.</li>}
      </ul>
      {profiles.repoRoot && <button onClick={() => { setEdit({ id: "", source: "local", name: "" }); setPerr(""); }}>New profile</button>}
      {edit && (
        <Dialog title={edit.id ? "Edit profile" : "New profile"} onClose={() => setEdit(null)} wide>
          <label className="field"><span>Name</span><input aria-label="Profile name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label className="field"><span>Setup script</span><textarea rows={4} className="mono" aria-label="Setup script" value={edit.script ?? ""} onChange={(e) => setEdit({ ...edit, script: e.target.value })} /></label>
          <label className="field"><span>Initial prompt</span><textarea rows={3} aria-label="Initial prompt" value={edit.initialPrompt ?? ""} onChange={(e) => setEdit({ ...edit, initialPrompt: e.target.value })} /></label>
          <label className="field"><span>Cleanup script</span><textarea rows={3} className="mono" aria-label="Cleanup script" value={edit.cleanupScript ?? ""} onChange={(e) => setEdit({ ...edit, cleanupScript: e.target.value })} /></label>
          {perr && <div className="error-text" role="alert">{perr}</div>}
          <div className="dialog-actions"><button onClick={() => setEdit(null)}>Cancel</button>
            <button className="primary" onClick={() => void bridge().profiles.save(folder, { id: edit.id || undefined, name: edit.name, script: edit.script, initialPrompt: edit.initialPrompt, cleanupScript: edit.cleanupScript }).then(() => { setEdit(null); void loadProfiles(); }).catch((e) => setPerr(String(e.message).replace(/^Error invoking remote method '[^']+': Error: /, "")))}>Save</button></div>
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Connectors (MCP only, spec §5.7)

/** A connection with one stored session loaded, for pages that have no session of their own. */
function useProbe(): { request?: (m: string, p?: Record<string, unknown>) => Promise<any>; none: boolean; error: string } {
  const a = useApp();
  const row = useMemo(() => a.sessions.filter((s) => s.archivedAt == null && !s.isSubagent && s.cwd).sort((x, y) => y.updatedAt - x.updatedAt)[0], [a.sessions]);
  const [conn, setConn] = useState<DaemonConn>();
  const [error, setError] = useState("");
  const id = row?.id;
  useEffect(() => {
    if (!row || a.daemon.state !== "running") return;
    let dead = false;
    let c: DaemonConn | undefined;
    (async () => {
      try {
        c = await DaemonConn.open();
        await c.request("load_session", { sessionId: row.id, cwd: row.cwd });
        if (dead) c.close(); else setConn(c);
      } catch (e) { setError((e as Error).message); c?.close(); }
    })();
    return () => { dead = true; c?.close(); setConn(undefined); };
  }, [id, a.daemon.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const request = useMemo(() => (conn ? conn.request.bind(conn) : undefined), [conn]);
  return { request, none: !row, error };
}

export function ConnectorSettings() {
  const probe = useProbe();
  const m = useMcp(probe.request);
  return (
    <>
      <h2>Connectors <ManagedNote keys={["mcpServers", "mcp"]} /></h2>
      <p className="muted">MCP servers the agent can use. Hosted connector catalogs are not part of this build.</p>
      {probe.none && <div className="banner warn" role="status">Start a session first. MCP servers are managed through a session.</div>}
      {probe.error && <div className="banner error" role="alert">{probe.error}</div>}
      {probe.request && (
        <>
          <div className="dlg-row"><h3>MCP Servers ({m.servers.length})</h3><span className="spacer" /><button onClick={() => void m.refresh()}>Refresh</button></div>
          {m.summary?.configError && <div className="banner warn" role="status">{m.summary.configError.path}: {m.summary.configError.message}</div>}
          <ServerList servers={m.servers} busy={m.busy} onRemove={(n) => void m.remove(n)} onSignIn={(n) => void m.signIn(n)} onSignOut={(n) => void m.signOut(n)} />
          <McpLoginPanel login={m.login} onCancel={m.stopWaiting} />
          <AddServerForm busy={m.busy} onAdd={m.add} />
          {m.error && <div className="banner error" role="alert">{m.error}</div>}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Session Management (spec §14.3, §12.1)

export function SessionManagement() {
  const a = useApp();
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [look, setLook] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState<SessionRow | "bulk" | null>(null);
  const [note, setNote] = useState("");
  const rows = useMemo(() => managementRows(a.sessions, tab, { query: q, project, lookbackDays: look }), [a.sessions, tab, q, project, look]);
  const projects = useMemo(() => [...new Set(a.sessions.map((s) => s.cwd).filter(Boolean) as string[])], [a.sessions]);
  const chosen = rows.filter((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setNote(ok); setSel(new Set()); } catch (e) { setNote((e as Error).message); } void app.refresh(); };
  const archive = (list: SessionRow[], archived: boolean) => run(async () => { for (const r of list) if ((r.archivedAt != null) !== archived) await app.sessionAction(r, "archive"); }, archived ? `Archived ${list.length}` : `Restored ${list.length}`);
  return (
    <>
      <h2>Session Management</h2>
      <div className="dlg-row">
        <div className="seg" role="tablist">{(["active", "archived"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setSel(new Set()); }}>{t === "active" ? "Active" : "Archived"}</button>)}</div>
        <input placeholder="Search sessions" aria-label="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Project filter" value={project} onChange={(e) => setProject(e.target.value)}><option value="">All projects</option>{projects.map((p) => <option key={p} value={p}>{projectName(p)}</option>)}</select>
        <select aria-label="Last updated" value={look} onChange={(e) => setLook(Number(e.target.value))}><option value={0}>Any time</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
      </div>
      <div className="dlg-row">
        <span className="muted small">{chosen.length} selected</span>
        <button disabled={!chosen.length} onClick={() => setRename("bulk")}>Rename</button>
        <button disabled={!chosen.length} onClick={() => void archive(chosen, tab === "active")}>{tab === "active" ? "Archive" : "Unarchive"}</button>
      </div>
      {note && <div className="banner small" role="status">{note}</div>}
      <table className="table" aria-label="Sessions">
        <thead><tr><th><input type="checkbox" aria-label="Select all" checked={!!rows.length && chosen.length === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th><th>Title</th><th>Project</th><th>Updated</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" aria-label={`Select ${r.title}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
              <td>{r.pinned ? "* " : ""}{r.title}</td><td className="small">{projectName(r.cwd)}</td><td className="small">{new Date(r.updatedAt).toLocaleDateString()}</td>
              <td className="row-ctl"><button onClick={() => setRename(r)}>Rename</button><button onClick={() => void archive([r], tab === "active")}>{tab === "active" ? "Archive" : "Unarchive"}</button></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="muted">No {tab} sessions.</td></tr>}
        </tbody>
      </table>
      {rename && rename !== "bulk" && <TextDialog title="Rename session" label="Title" initial={rename.title} action="Rename" onCancel={() => setRename(null)} onSubmit={(v) => { const r = rename; setRename(null); void run(() => app.sessionAction(r, "rename", v), "Renamed"); }} />}
      {rename === "bulk" && <BulkRename rows={chosen} onCancel={() => setRename(null)} onApply={(plan) => { setRename(null); void run(async () => { for (const p of plan) await app.sessionAction(p.row, "rename", p.title); }, `Renamed ${plan.length}`); }} />}
    </>
  );
}

function BulkRename({ rows, onCancel, onApply }: { rows: SessionRow[]; onCancel(): void; onApply(plan: { row: SessionRow; title: string }[]): void }) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const plan = bulkRename(rows, find, replace);
  return (
    <Dialog title={`Rename ${rows.length} sessions`} onClose={onCancel}>
      <label className="field"><span>Find</span><input aria-label="Find" value={find} onChange={(e) => setFind(e.target.value)} /></label>
      <label className="field"><span>Replace with</span><input aria-label="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} /></label>
      <ul className="plain-list small">{plan.slice(0, 8).map((p) => <li key={p.row.id}>{p.row.title} {"->"} {p.title}</li>)}{!plan.length && <li className="muted">No titles contain that text.</li>}</ul>
      <div className="dialog-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!plan.length} onClick={() => onApply(plan)}>Rename {plan.length}</button></div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Usage (local totals only)

interface UsageRow { row: SessionRow; usage: TokenUsage }

export function UsagePage() {
  const a = useApp();
  const recent = useMemo(() => a.sessions.filter((s) => !s.isSubagent && s.cwd).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 15), [a.sessions]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [ctx, setCtx] = useState<{ used: number; limit: number; title: string }>();
  const [busy, setBusy] = useState(false);
  const ran = useRef("");
  useEffect(() => {
    const key = recent.map((r) => r.id).join();
    if (!key || ran.current === key || a.daemon.state !== "running") return;
    ran.current = key;
    let dead = false;
    (async () => {
      setBusy(true);
      const out: UsageRow[] = [];
      for (const [i, row] of recent.entries()) {
        try {
          await app.withSession(row.id, row.cwd, async (c) => {
            const r = await c.request("load_session", { sessionId: row.id, cwd: row.cwd }).catch(() => null);
            out.push({ row, usage: addUsage(zero(), r?.tokenUsage) });
            if (i === 0) { const s = await c.request("get_context_stats").catch(() => null); if (s && !dead) setCtx({ used: s.used, limit: s.limit, title: row.title }); }
          });
        } catch { out.push({ row, usage: zero() }); }
        if (dead) return;
        setRows([...out]);
      }
      setBusy(false);
    })();
    return () => { dead = true; };
  }, [recent, a.daemon.state]);
  const sum = rows.reduce((t, r) => addUsage(t, r.usage), zero());
  const max = Math.max(1, ...rows.map((r) => total(r.usage)));
  return (
    <>
      <h2>Usage</h2>
      <p className="muted">Token totals from your recent sessions on this computer. Plan limits belong to hosted accounts and are not shown.</p>
      <div className="stats" data-testid="usage-totals">
        <div><div className="stat-n">{fmt(total(sum))}</div><div className="muted small">total tokens</div></div>
        <div><div className="stat-n">{fmt(sum.inputTokens)}</div><div className="muted small">input</div></div>
        <div><div className="stat-n">{fmt(sum.outputTokens)}</div><div className="muted small">output</div></div>
        <div><div className="stat-n">{fmt(sum.cacheReadTokens)}</div><div className="muted small">cache read</div></div>
      </div>
      {ctx && <Row label="Context window" hint={ctx.title}><meter min={0} max={100} value={percentUsed(ctx.used, ctx.limit)} aria-label="Context used" /><span className="small">{fmt(ctx.used)} of {fmt(ctx.limit)} ({percentUsed(ctx.used, ctx.limit)}%)</span></Row>}
      <table className="table" aria-label="Usage by session">
        <thead><tr><th>Session</th><th>Tokens</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.row.id}><td>{r.row.title}<div className="muted small">{projectName(r.row.cwd)}</div></td><td className="small">{fmt(total(r.usage))}</td><td className="barcell"><div className="bar" style={{ width: `${Math.round((total(r.usage) / max) * 100)}%` }} /></td></tr>)}
          {!rows.length && <tr><td colSpan={3} className="muted">{busy ? "Reading sessions" : "No sessions yet."}</td></tr>}
        </tbody>
      </table>
    </>
  );
}
