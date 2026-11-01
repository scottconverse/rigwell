// Automations page (spec §16.7): list (Active / Paused), create, detail with recent runs, pause / resume and run now.
// A banner warns that automations only run while the app is open (the dismissal is the automationQuitWarningDismissed setting).
import { useCallback, useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { SCHEDULE_PRESETS, buildCreate, duration, showQuitWarning, statusLabel, tabMatches, when, type AutomationRow, type CreateForm, type RunRow } from "../lib/automations.ts";
import { bridge } from "../lib/rpc.ts";
import { Dialog } from "./Dialogs.tsx";

const POLL_MS = 3000;

function useAutomations(enabled: boolean) {
  const [items, setItems] = useState<AutomationRow[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try { const r = await app.request("list_automations"); setItems(r.automations ?? []); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoaded(true); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);
  return { items, error, loaded, refresh };
}

function QuitWarning({ items }: { items: AutomationRow[] }) {
  const a = useApp();
  if (!showQuitWarning(items, a.settings?.automationQuitWarningDismissed === true)) return null;
  return (
    <div className="banner warn" role="status" data-testid="quit-warning">
      <span>Automations stop when the app quits. Keep Rigwell open for scheduled runs to happen.</span>
      <button onClick={() => void app.updateSettings({ automationQuitWarningDismissed: true })}>Don't show again</button>
    </div>
  );
}

export function Automations({ go }: { go(r: string): void }) {
  const a = useApp();
  const { items, error, loaded, refresh } = useAutomations(a.daemon.state === "running");
  const [tab, setTab] = useState<"Active" | "Paused">("Active");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState("");
  const shown = items.filter((x) => tabMatches(x, tab) && `${x.name} ${x.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setNote(ok); } catch (e) { setNote((e as Error).message); } void refresh(); };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Automations</h1>
        <span className="spacer" />
        <button onClick={() => void refresh()}>Refresh</button>
        <button className="primary" onClick={() => setCreating(true)}>New automation</button>
      </header>
      <QuitWarning items={items} />
      <div className="dlg-row">
        <div className="seg tabs" role="tablist">{(["Active", "Paused"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t} ({items.filter((x) => tabMatches(x, t)).length})</button>)}</div>
        <input placeholder="Search" aria-label="Search automations" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {note && <div className="banner small" role="status">{note}</div>}
      <table className="table" aria-label="Automations">
        <thead><tr><th>Name</th><th>Schedule</th><th>Status</th><th>Last run</th><th>Next run</th><th /></tr></thead>
        <tbody>
          {shown.map((x) => (
            <tr key={x.id}>
              <td><button className="link" onClick={() => go(`/automations/${x.id}`)}>{x.name}</button></td>
              <td className="small">{x.trigger === "webhook" ? "Webhook" : x.schedule}</td>
              <td><span className={`badge as-${x.status}`}>{statusLabel(x)}</span></td>
              <td className="small">{when(x.lastRunAt)}{x.lastRunStatus ? ` (${x.lastRunStatus})` : ""}</td>
              <td className="small">{x.paused ? "-" : when(x.nextRunAt)}</td>
              <td className="row-ctl">
                <button aria-label={`Run ${x.name} now`} disabled={!x.isValid} onClick={() => void act(() => app.request("run_automation", { id: x.id }), `Started ${x.name}`)}>Run now</button>
                <button aria-label={`${x.paused ? "Resume" : "Pause"} ${x.name}`} onClick={() => void act(() => app.request(x.paused ? "resume_automation" : "pause_automation", { id: x.id }), x.paused ? "Resumed" : "Paused")}>{x.paused ? "Resume" : "Pause"}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loaded && !shown.length && !error && <div className="empty-state">{items.length ? `No ${tab.toLowerCase()} automations match.` : "No automations yet. An automation is a saved prompt that runs on a schedule in its own session."}</div>}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void refresh(); go(`/automations/${id}`); }} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const a = useApp();
  const [f, setF] = useState<CreateForm>({ name: "", preset: "daily", custom: "", instructions: "", workingDirectory: a.recentFolders[0] ?? "", trigger: "schedule" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string }>();
  const set = (p: Partial<CreateForm>) => setF((x) => ({ ...x, ...p }));
  const submit = async () => {
    const r = buildCreate(f);
    if ("error" in r) { setError(r.error); return; }
    setBusy(true); setError("");
    try {
      const res = await app.request("create_automation", r.params);
      if (res.webhookSecret) setSecret({ id: res.automation.id, secret: res.webhookSecret }); else onCreated(res.automation.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (secret) {
    return (
      <Dialog title="Webhook secret" onClose={() => onCreated(secret.id)}>
        <p className="muted">Copy this secret now. It signs requests to the webhook and is not shown again.</p>
        <pre className="code-block" data-testid="webhook-secret">{secret.secret}</pre>
        <div className="dialog-actions"><button className="primary" onClick={() => onCreated(secret.id)}>Done</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="New automation" onClose={onClose} wide>
      <label className="field"><span>Name</span><input aria-label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <div className="field"><span>Trigger</span>
        <div className="seg"><button className={f.trigger === "schedule" ? "on" : ""} onClick={() => set({ trigger: "schedule" })}>Schedule</button><button className={f.trigger === "webhook" ? "on" : ""} onClick={() => set({ trigger: "webhook" })}>Webhook</button></div>
      </div>
      {f.trigger === "schedule" && (
        <div className="field"><span>Schedule</span>
          <select aria-label="Schedule" value={f.preset} onChange={(e) => set({ preset: e.target.value })}>{SCHEDULE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          {f.preset === "custom" && <input aria-label="Custom schedule" placeholder='every 30m, or 0 9 * * 1-5' value={f.custom} onChange={(e) => set({ custom: e.target.value })} />}
        </div>
      )}
      <div className="field"><span>Project folder</span>
        <div className="dlg-row"><input aria-label="Project folder" value={f.workingDirectory} onChange={(e) => set({ workingDirectory: e.target.value })} /><button onClick={() => void bridge().dialog.pickFolder().then((p) => p && set({ workingDirectory: p }))}>Browse</button></div>
      </div>
      <label className="field"><span>Instructions</span><textarea rows={6} aria-label="Instructions" value={f.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="What should the agent do each time this runs?" /></label>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void submit()}>Create</button></div>
    </Dialog>
  );
}

export function AutomationDetail({ id, go }: { id: string; go(r: string): void }) {
  const a = useApp();
  const { items, loaded, refresh } = useAutomations(a.daemon.state === "running");
  const x = items.find((i) => i.id === id);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadRuns = useCallback(async () => { try { const r = await app.request("get_automation_history", { id }); setRuns((r.runs ?? []).slice().sort((p: RunRow, q: RunRow) => q.startedAt - p.startedAt)); } catch { /* the automation may be gone */ } }, [id]);
  useEffect(() => { void loadRuns(); const t = setInterval(() => void loadRuns(), POLL_MS); return () => clearInterval(t); }, [loadRuns]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setNote(ok); } catch (e) { setNote((e as Error).message); } void refresh(); void loadRuns(); };

  if (!x) return <div className="center-note">{loaded ? "This automation was not found." : "Loading"}</div>;
  return (
    <div className="page">
      <header className="page-head">
        <button onClick={() => go("/automations")} aria-label="Back to Automations">Back</button>
        <h1>{x.name}</h1>
        <span className={`badge as-${x.status}`} data-testid="automation-status">{statusLabel(x)}</span>
        <span className="spacer" />
        <button className="primary" disabled={!x.isValid} onClick={() => void act(() => app.request("run_automation", { id }), "Run started")}>Run now</button>
        <button onClick={() => void act(() => app.request(x.paused ? "resume_automation" : "pause_automation", { id }), x.paused ? "Resumed" : "Paused")}>{x.paused ? "Resume" : "Pause"}</button>
        <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>
      </header>
      <QuitWarning items={items} />
      {note && <div className="banner small" role="status">{note}</div>}
      {!x.isValid && <div className="banner error" role="alert">{x.invalidReason ?? "This automation cannot run."}</div>}
      <dl className="facts">
        <dt>Trigger</dt><dd>{x.trigger === "webhook" ? `Webhook ${x.webhookPath ?? ""}${x.webhookPort ? ` on port ${x.webhookPort}` : ""}` : "Schedule"}</dd>
        {x.schedule && <><dt>Schedule</dt><dd>{x.schedule}{x.timezone ? ` (${x.timezone})` : ""}</dd></>}
        <dt>Last run</dt><dd>{when(x.lastRunAt)}{x.lastRunStatus ? ` (${x.lastRunStatus})` : ""}</dd>
        <dt>Next run</dt><dd>{x.paused ? "Paused" : when(x.nextRunAt)}</dd>
        <dt>Runs</dt><dd>{x.runCount}</dd>
        {x.workingDirectory && <><dt>Folder</dt><dd className="mono">{x.workingDirectory}</dd></>}
      </dl>
      <h2>Instructions</h2>
      <pre className="code-block">{x.instructions}</pre>
      <h2>Recent runs</h2>
      <table className="table" aria-label="Recent runs">
        <thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Duration</th><th /></tr></thead>
        <tbody>
          {runs.slice(0, 20).map((r) => (
            <tr key={r.runId}>
              <td className="small">{new Date(r.startedAt).toLocaleString()}</td><td className="small">{r.trigger}</td>
              <td><span className={`badge rs-${r.status}`}>{r.status.replace("_", " ")}</span>{r.errorMessage ? <div className="error-text small">{r.errorMessage}</div> : null}</td>
              <td className="small">{duration(r)}</td>
              <td>{r.sessionId && <button onClick={() => go(`/sessions/${r.sessionId}`)}>Open session</button>}</td>
            </tr>
          ))}
          {!runs.length && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table>
      {confirmDelete && (
        <Dialog title="Delete this automation?" onClose={() => setConfirmDelete(false)}>
          <p className="muted">Its folder, memory and run history are removed.</p>
          <div className="dialog-actions"><button onClick={() => setConfirmDelete(false)}>Cancel</button><button className="danger" onClick={() => void app.request("delete_automation", { id }).then(() => go("/automations"))}>Delete</button></div>
        </Dialog>
      )}
    </div>
  );
}
