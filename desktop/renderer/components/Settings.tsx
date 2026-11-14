import { useEffect, useState } from "react";
import type { DesktopSettings, SoundValue, ThemePref } from "../../main/settings.ts";
import { app, useApp } from "../lib/app-model.ts";
import { applyAppearance } from "../lib/appearance.ts";
import { bridge } from "../lib/rpc.ts";
import { Accounts, ApiKeys, Environments, VoiceSettings } from "./SettingsAccess.tsx";
import { CodeProviders } from "./CodeProviders.tsx";
import { ConnectorSettings, CustomModels, MissionSettings, SessionDefaults, SessionManagement, UsagePage, WorktreeSettings } from "./SettingsAgent.tsx";

const PAGES = [
  ["general", "General"], ["appearance", "Appearance"], ["notifications", "Notifications and sounds"], ["session-defaults", "Session Defaults"], ["missions", "Missions"],
  ["custom-models", "Custom Models"], ["worktrees", "Worktrees"], ["connectors", "Connectors"], ["session-management", "Session Management"], ["usage", "Usage"],
  ["api-keys", "API keys"], ["environments", "Environments"], ["accounts", "Accounts"], ["code-providers", "Code providers"], ["voice", "Voice dictation"], ["support", "Support"],
] as const;
const AGENT_PAGES: Record<string, () => React.ReactElement | null> = {
  "session-defaults": SessionDefaults, missions: MissionSettings, "custom-models": CustomModels, worktrees: WorktreeSettings,
  connectors: ConnectorSettings, "session-management": SessionManagement, usage: UsagePage,
  "api-keys": ApiKeys, environments: Environments, accounts: Accounts, "code-providers": CodeProviders, voice: VoiceSettings,
};

export function Settings({ page, go }: { page: string; go(r: string): void }) {
  const a = useApp();
  const s = a.settings;
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings">
        {PAGES.map(([id, label]) => <button key={id} className={page === id ? "on" : ""} aria-current={page === id} onClick={() => go(`/settings/${id}`)}>{label}</button>)}
      </nav>
      <div className="settings-body">
        {!s ? <div className="muted">Loading</div> : AGENT_PAGES[page] ? (() => { const P = AGENT_PAGES[page]; return <P />; })() : page === "appearance" ? <Appearance s={s} /> : page === "notifications" ? <Notifications s={s} /> : page === "support" ? <Support /> : <General s={s} />}
      </div>
    </div>
  );
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="row"><div className="row-label"><div>{label}</div>{hint && <div className="muted small">{hint}</div>}</div><div className="row-ctl">{children}</div></div>
);

const SHORTCUTS = [["spec", "Toggle Spec mode (Shift+Tab)"], ["reasoning", "Cycle reasoning (Tab)"], ["autonomy", "Cycle autonomy (Ctrl+L)"], ["files", "Files (Ctrl+P)"], ["terminal", "Terminal (Ctrl+J)"], ["browser", "Browser (Shift+Ctrl+B)"], ["sidechat", "Side chat (Alt+Ctrl+S)"], ["dictation", "Voice dictation (Ctrl+Shift+D)"]] as const;

function General({ s }: { s: DesktopSettings }) {
  const toggleShortcut = (id: string) => void app.updateSettings({ disabledShortcuts: s.disabledShortcuts.includes(id) ? s.disabledShortcuts.filter((x) => x !== id) : [...s.disabledShortcuts, id] });
  return (
    <>
      <h2>General</h2>
      <Row label="Language"><select value={s.locale} onChange={(e) => void app.updateSettings({ locale: e.target.value })}><option value="en">English</option></select></Row>
      <Row label="Open file previews automatically" hint="Show the project's README when the Files tab opens"><input type="checkbox" checked={s.autoOpenFilePreviews} onChange={(e) => void app.updateSettings({ autoOpenFilePreviews: e.target.checked })} /></Row>
      <Row label="Keep running with the screen off" hint="Stops the computer from sleeping while the app is open"><input type="checkbox" checked={s.keepAwakeEnabled} onChange={(e) => void app.updateSettings({ keepAwakeEnabled: e.target.checked })} /></Row>
      <Row label="Check for updates automatically"><input type="checkbox" checked={s.desktopAutoUpdateEnabled} onChange={(e) => void app.updateSettings({ desktopAutoUpdateEnabled: e.target.checked })} /></Row>
      <Row label="Update feed URL" hint="Folder (or .yml / .json file) that lists the newest version. Empty means no update checks."><input type="url" aria-label="Update feed URL" placeholder="https://example.com/rigwell" defaultValue={s.updateFeedUrl} onBlur={(e) => { if (e.target.value !== s.updateFeedUrl) void app.updateSettings({ updateFeedUrl: e.target.value.trim() }); }} /></Row>
      <Row label="Update public key" hint="Ed25519 key (PEM, or base64 of the 32 raw bytes) that signed Linux updates must match. Without a key, Linux updates are refused."><input aria-label="Update public key" placeholder="base64 or -----BEGIN PUBLIC KEY-----" defaultValue={s.updatePublicKey} onBlur={(e) => { if (e.target.value.trim() !== s.updatePublicKey) void app.updateSettings({ updatePublicKey: e.target.value.trim() }); }} /></Row>
      <Row label="Tray icon" hint="Shows Rigwell in the system tray or menu bar with the number of active sessions"><input type="checkbox" aria-label="Tray icon" checked={s.menuBarEnabled} onChange={(e) => void app.updateSettings({ menuBarEnabled: e.target.checked })} /></Row>
      <h3>Shortcuts</h3>
      {SHORTCUTS.map(([id, label]) => <Row key={id} label={label}><input type="checkbox" aria-label={label} checked={!s.disabledShortcuts.includes(id)} onChange={() => toggleShortcut(id)} /></Row>)}
    </>
  );
}

function SoundPicker({ label, value, onChange, kind }: { label: string; value: SoundValue; onChange(v: SoundValue): void; kind: "awaiting" | "completion" }) {
  const sel = typeof value === "object" ? "file" : value;
  return (
    <Row label={label}>
      <select value={sel} aria-label={label} onChange={async (e) => {
        const v = e.target.value;
        if (v === "file") { const p = await bridge().dialog.pickFile([{ name: "Audio", extensions: ["wav", "mp3", "ogg"] }]); if (p) onChange({ file: p }); } else onChange(v as SoundValue);
      }}>
        <option value="off">Off</option><option value="bell">Bell</option><option value="ok">Chime</option><option value="ack">Blip</option><option value="file">Custom file...</option>
      </select>
      {typeof value === "object" && <span className="muted small"> {value.file.split("/").pop()}</span>}
      <button onClick={() => void bridge().app.testSound(kind)}>Test</button>
    </Row>
  );
}

function Notifications({ s }: { s: DesktopSettings }) {
  const up = (patch: unknown) => void app.updateSettings(patch);
  return (
    <>
      <h2>Notifications and sounds</h2>
      <h3>Desktop alerts</h3>
      <Row label="Finished" hint="When the agent finishes a turn"><input type="checkbox" aria-label="Finished alerts" checked={s.notifications.finished} onChange={(e) => up({ notifications: { finished: e.target.checked } })} /></Row>
      <Row label="Needs input" hint="Questions and approvals"><input type="checkbox" aria-label="Needs input alerts" checked={s.notifications.needsInput} onChange={(e) => up({ notifications: { needsInput: e.target.checked } })} /></Row>
      <h3>Sounds</h3>
      <SoundPicker label="When the agent finishes" kind="completion" value={s.sounds.completionSound} onChange={(v) => up({ sounds: { completionSound: v } })} />
      <SoundPicker label="When the agent needs you" kind="awaiting" value={s.sounds.awaitingInputSound} onChange={(v) => up({ sounds: { awaitingInputSound: v } })} />
      <Row label="Volume"><input type="range" min={0} max={100} value={s.sounds.soundVolume} aria-label="Volume" onChange={(e) => up({ sounds: { soundVolume: Number(e.target.value) } })} /> <span className="small">{s.sounds.soundVolume}</span></Row>
      <Row label="Play sounds"><select value={s.sounds.soundFocusMode} aria-label="Sound focus mode" onChange={(e) => up({ sounds: { soundFocusMode: e.target.value } })}><option value="always">Always</option><option value="focused">Only when the app is focused</option><option value="unfocused">Only when the app is in the background</option></select></Row>
      <Row label="Subagent sounds" hint="Quiet mode rings the bell only"><select value={s.sounds.subagentSounds} aria-label="Subagent sounds" onChange={(e) => up({ sounds: { subagentSounds: e.target.value } })}><option value="off">Off</option><option value="quiet">Quiet</option></select></Row>
    </>
  );
}

function Appearance({ s }: { s: DesktopSettings }) {
  const ap = s.appearance;
  const [tokens, setTokens] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => setTokens(JSON.stringify(ap.tokens ?? {}, null, 2)), [ap.tokens]);
  // Apply to the page at once (no wait for the round trip), then save.
  const set = (patch: Partial<DesktopSettings["appearance"]>) => { applyAppearance({ ...ap, ...patch }); void app.updateSettings({ appearance: patch }); };
  const importTokens = () => { try { const t = JSON.parse(tokens); set({ tokens: t }); setErr(""); } catch { setErr("That is not valid JSON."); } };
  return (
    <>
      <h2>Appearance</h2>
      <Row label="Theme">
        <div className="seg" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as ThemePref[]).map((t) => <button key={t} role="radio" aria-checked={ap.theme === t} className={ap.theme === t ? "on" : ""} onClick={() => set({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
      </Row>
      <Row label="Accent color"><input type="color" value={ap.accent ?? "#4f8cff"} aria-label="Accent color" onChange={(e) => set({ accent: e.target.value })} /> <button onClick={() => set({ accent: undefined })}>Reset</button></Row>
      <Row label="Startup background (dark)" hint="Painted before the page loads"><input type="color" value={ap.startupBackground.dark} aria-label="Dark startup background" onChange={(e) => set({ startupBackground: { ...ap.startupBackground, dark: e.target.value } })} /></Row>
      <Row label="Startup background (light)"><input type="color" value={ap.startupBackground.light} aria-label="Light startup background" onChange={(e) => set({ startupBackground: { ...ap.startupBackground, light: e.target.value } })} /></Row>
      <Row label="Contrast"><select value={ap.contrast} aria-label="Contrast" onChange={(e) => set({ contrast: e.target.value as "normal" | "high" })}><option value="normal">Normal</option><option value="high">High</option></select></Row>
      <Row label="Interface font"><input value={ap.uiFont} aria-label="Interface font" onChange={(e) => set({ uiFont: e.target.value })} /> <input type="number" min={11} max={20} value={ap.uiFontSize} aria-label="Interface font size" onChange={(e) => set({ uiFontSize: Number(e.target.value) })} /></Row>
      <Row label="Content font"><input value={ap.contentFont} aria-label="Content font" onChange={(e) => set({ contentFont: e.target.value })} /> <input type="number" min={11} max={22} value={ap.contentFontSize} aria-label="Content font size" onChange={(e) => set({ contentFontSize: Number(e.target.value) })} /></Row>
      <Row label="Code font"><input value={ap.codeFont} aria-label="Code font" onChange={(e) => set({ codeFont: e.target.value })} /> <input type="number" min={10} max={20} value={ap.codeFontSize} aria-label="Code font size" onChange={(e) => set({ codeFontSize: Number(e.target.value) })} /></Row>
      <Row label="Diff view">
        <select value={ap.diffView.mode} aria-label="Diff view" onChange={(e) => set({ diffView: { ...ap.diffView, mode: e.target.value as "unified" | "split" } })}><option value="unified">Unified</option><option value="split">Split</option></select>
        <label className="check small"><input type="checkbox" checked={ap.diffView.wrap} onChange={(e) => set({ diffView: { ...ap.diffView, wrap: e.target.checked } })} />Wrap</label>
        <label className="check small"><input type="checkbox" checked={ap.diffView.markers} onChange={(e) => set({ diffView: { ...ap.diffView, markers: e.target.checked } })} />+/- markers</label>
      </Row>
      <Row label="Reduce motion"><input type="checkbox" aria-label="Reduce motion" checked={ap.reduceMotion} onChange={(e) => set({ reduceMotion: e.target.checked })} /></Row>
      <h3>Theme colors</h3>
      <p className="muted small">Named color tokens per theme as JSON, for example {`{"dark": {"surface": "#1e1d1c"}, "light": {}}`}. Copy this to share a theme, or paste one and import it.</p>
      <textarea className="tokens" value={tokens} onChange={(e) => setTokens(e.target.value)} aria-label="Theme tokens" rows={6} />
      <div className="row-ctl"><button onClick={importTokens}>Import</button><button onClick={() => void navigator.clipboard.writeText(tokens)}>Copy</button>{err && <span className="error-text">{err}</span>}</div>
    </>
  );
}

function Support() {
  const [info, setInfo] = useState<any>();
  const a = useApp();
  useEffect(() => { void bridge().app.info().then(setInfo); }, [a.daemon.state]);
  const diag = info ? `Rigwell ${info.version}\nElectron ${info.electron}\nChrome ${info.chrome}\nPlatform ${info.platform}\nHome ${info.home}\nBackground service: ${info.daemon.state} (pid ${info.daemon.pid ?? "none"})` : "";
  return (
    <>
      <h2>Support</h2>
      <pre className="diag" data-testid="diagnostics">{diag}</pre>
      <div className="row-ctl">
        <button onClick={() => void navigator.clipboard.writeText(diag)}>Copy diagnostics</button>
        <button onClick={() => void bridge().daemon.restart()}>Restart background service</button>
        <button onClick={() => info && void bridge().shell.openPath(`${info.home}/logs`)}>Open logs folder</button>
      </div>
    </>
  );
}
