import { useEffect, useState } from "react";
import { app, useApp } from "../lib/app-model.ts";
import { bridge } from "../lib/rpc.ts";
import { SessionController } from "../lib/session.ts";
import { Composer, type ComposerSettings } from "./Composer.tsx";
import { live } from "./SessionScreen.tsx";

export function Home({ go, initialFolder }: { go(route: string): void; initialFolder?: string }) {
  const a = useApp();
  const [folder, setFolder] = useState(initialFolder ?? a.recentFolders[0] ?? "");
  const [folderOpen, setFolderOpen] = useState(false);
  const [settings, setSettings] = useState<ComposerSettings>({ autonomyLevel: "medium", interactionMode: "auto", reasoningEffort: "high" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!settings.modelId && a.models[0]) setSettings((s) => ({ ...s, modelId: a.models[0].id })); }, [a.models, settings.modelId]);
  useEffect(() => { if (!folder && a.recentFolders[0]) setFolder(a.recentFolders[0]); }, [a.recentFolders, folder]);

  const addFolder = async () => { const p = await bridge().dialog.pickFolder(); if (p) { setFolder(p); app.rememberFolder(p); setFolderOpen(false); } };

  const start = async (text: string) => {
    if (!folder) { setError("Choose a folder first."); return; }
    setBusy(true); setError("");
    try {
      const ctl = await SessionController.create({ cwd: folder, modelId: settings.modelId, autonomyLevel: settings.autonomyLevel, interactionMode: settings.interactionMode, reasoningEffort: settings.reasoningEffort });
      const id = ctl.getSnapshot().sessionId!;
      live.set(id, ctl);
      app.rememberFolder(folder);
      void app.refresh();
      go(`/sessions/${id}`);
      void ctl.send(text);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const running = a.daemon.state === "running";
  return (
    <div className="home">
      <div className="home-inner">
        <div className="wordmark">Rigwell</div>
        {!running && <div className="banner warn" role="status">{a.daemon.state === "failed" ? `The background service could not start. ${a.daemon.error ?? ""}` : `Background service: ${a.daemon.state}`}
          {a.daemon.state === "failed" && <button onClick={() => void bridge().daemon.restart()}>Try again</button>}</div>}
        <div className="chips top">
          <span className="chip static" title="Where the agent runs">Local</span>
          <div className="chip-wrap">
            <button className="chip" onClick={() => setFolderOpen(!folderOpen)} aria-haspopup="listbox">{folder ? folder.split("/").filter(Boolean).slice(-2).join("/") : "Choose folder"}</button>
            {folderOpen && (
              <div className="menu" role="listbox">
                {a.recentFolders.map((f) => <button key={f} role="option" aria-selected={f === folder} className="menu-item" onClick={() => { setFolder(f); setFolderOpen(false); }}>{f}</button>)}
                <button className="menu-item" onClick={() => void addFolder()}>+ Add new project</button>
              </div>
            )}
          </div>
        </div>
        <Composer settings={settings} models={a.models} busy={false} disabled={busy || !running} autoFocus disabledShortcuts={a.settings?.disabledShortcuts}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))} onSend={(t) => void start(t)} onStop={() => {}} />
        {error && <div className="banner error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
