import { useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { SessionController } from "../lib/session.ts";
import { Composer, type ComposerSettings } from "./Composer.tsx";
import { toParams } from "../lib/attachments.ts";
import { Accounts } from "./SettingsAccess.tsx";
import { TrustDialog } from "./Dialogs.tsx";
import { live, pendingMission } from "./SessionScreen.tsx";

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
  const adder = useAddFolder((p) => { setFolder(p); setFolderOpen(false); });

  const defaults = a.userSettings.sessionDefaultSettings as Record<string, string> | undefined;
  useEffect(() => { if (!settings.modelId && a.models[0]) setSettings((s) => ({ ...s, modelId: defaults?.model && a.models.some((m) => m.id === defaults.model) ? defaults.model : a.models[0].id })); }, [a.models, settings.modelId, defaults?.model]);
  useEffect(() => {
    if (!defaults) return;
    setSettings((s) => ({ ...s, reasoningEffort: defaults.reasoningEffort ?? s.reasoningEffort, autonomyLevel: defaults.autonomyLevel ?? s.autonomyLevel, interactionMode: defaults.interactionMode === "spec" ? "spec" : s.interactionMode }));
  }, [defaults?.reasoningEffort, defaults?.autonomyLevel, defaults?.interactionMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!folder && a.recentFolders[0]) setFolder(a.recentFolders[0]); }, [a.recentFolders, folder]);

  // spec §18.1: runInWorktree is the default for this toggle; the choice is per session.
  const useWorktree = worktree ?? a.userSettings.runInWorktree === true;

  const start = async (text: string, attach: ReturnType<typeof toParams> = {}) => {
    if (!folder) { setError("Choose a folder first."); return; }
    setBusy(true); setError("");
    const mission = settings.interactionMode === "mission";
    try {
      const ctl = await SessionController.create({
        cwd: folder, title: text.split("\n")[0].slice(0, 60), modelId: settings.modelId, autonomyLevel: settings.autonomyLevel,
        interactionMode: mission ? "auto" : settings.interactionMode, reasoningEffort: settings.reasoningEffort, ...(useWorktree ? { worktree: true } : {}),
      });
      const id = ctl.getSnapshot().sessionId!;
      live.set(id, ctl);
      if (mission) pendingMission.add(id);
      app.rememberFolder(folder);
      void app.refresh();
      go(`/sessions/${id}`);
      void ctl.send(text, attach);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const running = a.daemon.state === "running";
  return (
    <div className="home">
      <div className="home-inner">
        <div className="wordmark">Rigwell</div>
        {!running && <div className="banner warn" role="status">{a.daemon.state === "failed" ? `The background service could not start. ${a.daemon.error ?? ""}` : `Background service: ${a.daemon.state}`}
          {a.daemon.state === "failed" && <button onClick={() => void bridge().daemon.restart()}>Try again</button>}</div>}
        {running && !a.models.length && <section aria-label="Connect a model" className="banner">
          <Accounts setup onSignedIn={() => { void app.refresh(); }} />
          <h3>API key or local model</h3>
          <p className="muted small">After connecting an account, configure a model to use it. You can also use a provider API key or a local server.</p>
          <button onClick={() => go("/settings/custom-models")}>Configure a model</button>
          <button onClick={() => go("/settings/api-keys")}>Store an API key</button>
        </section>}
        <div className="chips top">
          <span className="chip static" title="Where the agent runs">Local</span>
          <div className="chip-wrap">
            <button className="chip" onClick={() => setFolderOpen(!folderOpen)} aria-haspopup="listbox">{folder ? folder.split("/").filter(Boolean).slice(-2).join("/") : "Choose folder"}</button>
            {folderOpen && (
              <div className="menu" role="listbox">
                {a.recentFolders.map((f) => <button key={f} role="option" aria-selected={f === folder} className="menu-item" onClick={() => { setFolder(f); setFolderOpen(false); }}>{f}</button>)}
                <button className="menu-item" onClick={() => void adder.pick()}>+ Add new project</button>
              </div>
            )}
          </div>
          <label className="chip check" title="Run this session in its own git worktree and branch"><input type="checkbox" checked={useWorktree} onChange={(e) => setWorktree(e.target.checked)} aria-label="Worktree" />Worktree</label>
        </div>
        <Composer settings={settings} models={a.models} busy={false} disabled={busy || !running || !a.models.length} autoFocus disabledShortcuts={a.settings?.disabledShortcuts} cwd={folder}
          autoAvailable={!!a.userSettings.autoRouter} onMission={() => setSettings((s) => ({ ...s, interactionMode: "mission" }))}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))} onSend={(t, atts) => void start(t, atts ? toParams(atts) : {})} onStop={() => {}} />
        {error && <div className="banner error" role="alert">{error}</div>}
      </div>
      {adder.dialog}
    </div>
  );
}
