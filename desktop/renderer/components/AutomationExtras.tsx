// Automations: the templates picker, the VISUAL.html viewer and the "set up by chatting" entry (docs/automations.md).
import { useCallback, useEffect, useRef, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import type { RunRow } from "../lib/automations.ts";
import { bridge } from "../lib/rpc.ts";
import { SessionController } from "../lib/session.ts";
import { defaultParams, groupTemplates, previewInstructions, templateCreate, visualStale, type TemplateRow } from "../lib/templates.ts";
import { Dialog } from "./Dialogs.tsx";
import { live } from "./SessionScreen.tsx";

function FolderField({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="field"><span>Project folder</span>
      <div className="dlg-row"><input aria-label="Project folder" value={value} onChange={(e) => onChange(e.target.value)} /><button onClick={() => void bridge().dialog.pickFolder().then((p) => p && onChange(p))}>Browse</button></div>
    </div>
  );
}

/** Pick a template, fill in its parameters, create. Creating never starts a run. */
export function TemplateDialog({ onClose, onCreated, onChat }: { onClose(): void; onCreated(id: string): void; onChat(t: TemplateRow, values: Record<string, string>): void }) {
  const a = useApp();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [picked, setPicked] = useState<TemplateRow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState(a.recentFolders[0] ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void app.request("list_automation_templates").then((r) => setTemplates(r.templates ?? []), (e) => setError((e as Error).message)); }, []);

  const pick = (t: TemplateRow) => { setPicked(t); setValues(defaultParams(t)); setError(""); };
  const create = async () => {
    if (!picked) return;
    const r = templateCreate(picked, values, { workingDirectory: folder });
    if ("error" in r) { setError(r.error); return; }
    setBusy(true); setError("");
    try { const res = await app.request("create_automation", r.params); onCreated(res.automation.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!picked) {
    return (
      <Dialog title="Automation templates" onClose={onClose} wide>
        {error && <div className="error-text" role="alert">{error}</div>}
        {groupTemplates(templates).map((g) => (
          <section key={g.category} aria-label={g.category}>
            <h3 className="cap">{g.category}</h3>
            <div className="template-grid">
              {g.templates.map((t) => (
                <button key={t.id} className="template-card" data-template={t.id} onClick={() => pick(t)}>
                  <b>{t.name}</b><span className="muted small">{t.description}</span>{t.schedule && <span className="small">{t.schedule}</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
        {!templates.length && !error && <div className="muted">Loading</div>}
        <div className="dialog-actions"><button onClick={onClose}>Cancel</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title={`New automation: ${picked.name}`} onClose={onClose} wide>
      <p className="muted">{picked.description}</p>
      {picked.parameters.map((p) => (
        <label className="field" key={p.key}><span>{p.label}{p.default === undefined ? " (required)" : ""}</span>
          <input aria-label={p.label} value={values[p.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} />
          {p.description && <span className="muted small">{p.description}</span>}
        </label>
      ))}
      <FolderField value={folder} onChange={setFolder} />
      <div className="field"><span>Schedule</span><span className="small" data-testid="template-schedule">{picked.schedule ?? "none"}{picked.autonomy ? `, autonomy ${picked.autonomy}` : ""}</span></div>
      <details><summary>Instructions preview</summary><pre className="code-block" data-testid="template-preview">{previewInstructions(picked, values)}</pre></details>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button onClick={() => setPicked(null)}>Back</button>
        <button onClick={() => onChat(picked, values)}>Refine by chatting</button>
        <button className="primary" disabled={busy} onClick={() => void create()}>Create automation</button>
      </div>
    </Dialog>
  );
}

/** Guided create-by-chatting: starts a setup session (start_automation_setup) and opens it. */
export function SetupDialog({ template, values, onClose, go }: { template?: TemplateRow; values?: Record<string, string>; onClose(): void; go(route: string): void }) {
  const a = useApp();
  const [folder, setFolder] = useState(a.recentFolders[0] ?? "");
  const [goal, setGoal] = useState(template ? `Set up the "${template.name}" automation.` : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!folder.trim()) { setError("Choose a project folder."); return; }
    setBusy(true); setError("");
    try {
      const ctl = await SessionController.createSetup({ cwd: folder.trim(), ...(template ? { templateId: template.id, templateParameters: values } : {}) });
      const id = ctl.getSnapshot().sessionId!;
      live.set(id, ctl);
      app.rememberFolder(folder.trim());
      void app.refresh();
      go(`/sessions/${id}`);
      if (goal.trim()) void ctl.send(goal.trim());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Set up an automation by chatting" onClose={onClose}>
      <p className="muted">The agent asks a few questions, then proposes the automation for you to approve.</p>
      <FolderField value={folder} onChange={setFolder} />
      <label className="field"><span>What should it do?</span><textarea rows={3} aria-label="What should it do?" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Optional: describe the job in a sentence" /></label>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void start()}>Start setup</button></div>
    </Dialog>
  );
}

/** VISUAL.html in a sandboxed frame (no same-origin, no network). Refreshed on a timer while a run is in progress. */
export function VisualPanel({ id, runs }: { id: string; runs: RunRow[] }) {
  const [html, setHtml] = useState<string>();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const load = useCallback(async () => {
    try { const r = await app.request("get_automation_visual", { id }); setHtml(r.html); setPath(r.path); setError(""); } catch (e) { setError((e as Error).message); }
  }, [id]);
  const finished = runs.filter((r) => r.status !== "in_progress").length;
  useEffect(() => { void load(); }, [load, finished]);
  useEffect(() => {
    if (!visualStale(runs)) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [runs, load]);
  const theme = () => frame.current?.contentWindow?.postMessage({ type: "theme", theme: document.documentElement.dataset.theme === "light" ? "light" : document.documentElement.dataset.theme === "dark" ? "dark" : "auto" }, "*");
  return (
    <section aria-label="Overview">
      <div className="dlg-row"><h2>Overview</h2><span className="spacer" />{path && <button onClick={() => void bridge().shell.openPath(path)} title={path}>Open file</button>}<button onClick={() => void load()}>Refresh</button></div>
      {error && <div className="banner error" role="alert">{error}</div>}
      {html !== undefined && <iframe ref={frame} title="Automation overview" className="visual-frame" sandbox="" srcDoc={html} onLoad={theme} />}
    </section>
  );
}
