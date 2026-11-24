import { useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { SessionController } from "../lib/session.ts";
import { Composer, type ComposerSettings } from "./Composer.tsx";
import { toParams, type Attachment } from "../lib/attachments.ts";
import { Accounts } from "./SettingsAccess.tsx";
import { TrustDialog } from "./Dialogs.tsx";
import { live, pendingMission, pendingMissionSend } from "./SessionScreen.tsx";
import { normalizeModel, type ModelRow } from "../lib/models.ts";
import { ICONS24, NavIcon } from "./NavIcon.tsx";
import type { Machine } from "../../../src/machines/store.ts";

/** Picks a folder and runs the trust prompt (spec §5.6) when it is not trusted yet. Returns the folder, or null when cancelled. */
export function useAddFolder(onAdded: (folder: string) => void) {
  const [asking, setAsking] = useState<string | null>(null);
  const pick = async (known?: string) => {
    const p = known ?? (await bridge().dialog.pickFolder());
    if (!p) return;
    if (app.isTrusted(p)) { app.rememberFolder(p); onAdded(p); } else setAsking(p);
  };
  const dialog = asking ? (
    <TrustDialog folder={asking}
      onCancel={() => setAsking(null)}
      onTrust={() => { const p = asking; setAsking(null); void app.trust(p).then(() => { app.rememberFolder(p); onAdded(p); }); }} />
  ) : null;
  return { pick, dialog };
}

export function Home({ go, initialFolder, initialMission }: { go(route: string): void; initialFolder?: string; initialMission?: boolean }) {
  const a = useApp();
  const [folder, setFolder] = useState(initialFolder ?? a.recentFolders[0] ?? "");
  const [folderOpen, setFolderOpen] = useState(false);
  const [settings, setSettings] = useState<ComposerSettings>({ autonomyLevel: "medium", interactionMode: initialMission ? "mission" : "auto", reasoningEffort: "high" });
  const [worktree, setWorktree] = useState<boolean | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [machine, setMachine] = useState(""), [machines, setMachines] = useState<Machine[]>([]), [remoteModels, setRemoteModels] = useState<ModelRow[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const models = machine ? remoteModels : a.models;
  const adder = useAddFolder((p) => { setFolder(p); setFolderOpen(false); });

  useEffect(() => { if (a.daemon.state === "running") void app.request("machine_list").then((r) => setMachines(r.machines ?? [])).catch((e) => setError(e.message)); }, [a.daemon.state]);
  useEffect(() => {
    if (!machine) { setModelsBusy(false); return; }
    let current = true; setModelsBusy(true); setRemoteModels([]);
    void app.request("machine_models", { name: machine }).then((r) => {
      if (!current) return; const rows = (r.models ?? []).map(normalizeModel); setRemoteModels(rows); setSettings((s) => ({ ...s, modelId: rows[0]?.id }));
    }).catch((e) => { if (current) setError(e.message); }).finally(() => { if (current) setModelsBusy(false); });
    return () => { current = false; };
  }, [machine]);

  const defaults = a.userSettings.sessionDefaultSettings as Record<string, string> | undefined;
  useEffect(() => { if (!machine && !settings.modelId && a.models[0]) setSettings((s) => ({ ...s, modelId: defaults?.model && a.models.some((m) => m.id === defaults.model) ? defaults.model : a.models[0].id })); }, [a.models, settings.modelId, defaults?.model, machine]);
  useEffect(() => {
    if (!defaults) return;
    setSettings((s) => ({ ...s, reasoningEffort: defaults.reasoningEffort ?? s.reasoningEffort, autonomyLevel: defaults.autonomyLevel ?? s.autonomyLevel, interactionMode: defaults.interactionMode === "spec" ? "spec" : s.interactionMode }));
  }, [defaults?.reasoningEffort, defaults?.autonomyLevel, defaults?.interactionMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!machine && !folder && a.recentFolders[0]) setFolder(a.recentFolders[0]); }, [a.recentFolders, folder, machine]);

  // spec §18.1: runInWorktree is the default for this toggle; the choice is per session.
  const useWorktree = worktree ?? a.userSettings.runInWorktree === true;

  const start = async (text: string, atts: Attachment[] = []) => {
    if (!folder) { setError("Choose a folder first."); return; }
    setBusy(true); setError("");
    const mission = settings.interactionMode === "mission";
    try {
      const ctl = await SessionController.create({
        cwd: folder, title: text.split("\n")[0].slice(0, 60), modelId: settings.modelId, autonomyLevel: settings.autonomyLevel,
        ...(machine ? { machine } : {}),
        interactionMode: mission ? "auto" : settings.interactionMode, reasoningEffort: settings.reasoningEffort, ...(useWorktree ? { worktree: true } : {}),
      });
      const id = ctl.getSnapshot().sessionId!;
      live.set(id, ctl);
      // Mission mode is entered by the session screen (readiness check, tool list). Sending first made the first
      // model request run in auto mode with no mission tools, so the orchestrator wasted a request looking for them.
      if (mission) { pendingMission.add(id); pendingMissionSend.set(id, { text, atts }); }
      if (!machine) app.rememberFolder(folder);
      void app.refresh();
      go(`/sessions/${id}`);
      if (!mission) void ctl.send(text, toParams(atts));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const running = a.daemon.state === "running";
  return (
    <div className="home">
      <div className="home-inner">
        <svg className="home-mark" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Rigwell">
          <path d="M50 10L26 66M50 10l24 56M34 46h32M29 58h42M50 10v14" /><path d="M18 74h64" />
          <path d="M50 80c-5 6-7 9-7 12a7 7 0 0 0 14 0c0-3-2-6-7-12z" stroke="var(--accent)" />
        </svg>
        <h1 className="home-title">{settings.interactionMode === "mission" ? "What should the mission do?" : "What should we work on?"}</h1>
        {!running && <div className="banner warn" role="status">{a.daemon.state === "failed" ? `The background service could not start. ${a.daemon.error ?? ""}` : `Background service: ${a.daemon.state}`}
          {a.daemon.state === "failed" && <button onClick={() => void bridge().daemon.restart()}>Try again</button>}</div>}
        {running && !machine && !a.models.length && <section aria-label="Connect a model" className="banner">
          <Accounts setup onSignedIn={() => { void app.refresh(); }} />
          <h3>API key or local model</h3>
          <p className="muted small">After connecting an account, configure a model to use it. You can also use a provider API key or a local server.</p>
          <button onClick={() => go("/settings/custom-models")}>Configure a model</button>
          <button onClick={() => go("/settings/api-keys")}>Store an API key</button>
        </section>}
        <Composer settings={settings} models={models} busy={false} disabled={busy || modelsBusy || !running || !models.length} autoFocus disabledShortcuts={a.settings?.disabledShortcuts} cwd={folder}
          autoAvailable={!!a.userSettings.autoRouter} onMission={() => setSettings((s) => ({ ...s, interactionMode: "mission" }))}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))} onSend={(t, atts) => void start(t, atts)} onStop={() => {}} />
        <div className="chips under">
          <select className="chip" aria-label="Session machine" value={machine} disabled={busy} onChange={(e) => { setMachine(e.target.value); setFolder(e.target.value ? "" : a.recentFolders[0] ?? ""); setSettings((s) => ({ ...s, modelId: undefined })); setError(""); }}>
            <option value="">Local</option>{machines.map((m) => <option key={m.name} value={m.name} disabled={!m.build}>{m.name}{m.build ? "" : " (bootstrap required)"}</option>)}
          </select>
          <button className="chip" onClick={() => go("/settings/machines")}>Manage machines</button>
          {machine ? <input className="chip" aria-label="Remote working folder" value={folder} placeholder="Working folder on the remote machine" onChange={(e) => setFolder(e.target.value)} /> : <div className="chip-wrap">
            <button className="chip" onClick={() => setFolderOpen(!folderOpen)} aria-haspopup="listbox"><NavIcon d={ICONS24.folder} grid={24} size={14} />{folder ? folder.split("/").filter(Boolean).slice(-2).join("/") : "Choose folder"}</button>
            {folderOpen && (
              <div className="menu" role="listbox">
                {a.recentFolders.map((f) => <button key={f} role="option" aria-selected={f === folder} className="menu-item" onClick={() => { setFolder(f); setFolderOpen(false); }}>{f}</button>)}
                <button className="menu-item" onClick={() => void adder.pick()}>+ Add new project</button>
              </div>
            )}
          </div>}
          <label className="chip check" title="Run this session in its own git worktree and branch"><input type="checkbox" checked={useWorktree} onChange={(e) => setWorktree(e.target.checked)} aria-label="Worktree" />Worktree</label>
        </div>
        {error && <div className="banner error" role="alert">{error}</div>}
      </div>
      {adder.dialog}
    </div>
  );
}
