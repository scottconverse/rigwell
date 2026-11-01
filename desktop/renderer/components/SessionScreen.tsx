import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { app, useApp, useStore } from "../lib/app-model.ts";
import { SessionController } from "../lib/session.ts";
import { toMarkdown } from "../lib/transcript.ts";
import { Composer } from "./Composer.tsx";
import { Prompts } from "./Prompts.tsx";
import { SidePane, type PaneTab } from "./SidePane.tsx";
import { Transcript } from "./Transcript.tsx";

/** Controllers for sessions created in this window, so Home can hand one over without reconnecting. */
export const live = new Map<string, SessionController>();

const PANE_KEYS: { test(e: KeyboardEvent): boolean; tab: PaneTab; id: string }[] = [
  { id: "files", tab: "files", test: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p" },
  { id: "terminal", tab: "terminal", test: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j" },
  { id: "browser", tab: "browser", test: (e) => e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "b" },
  { id: "sidechat", tab: "side", test: (e) => e.ctrlKey && e.altKey && e.key.toLowerCase() === "s" },
];

function useController(sessionId: string): { ctl?: SessionController; error?: string } {
  const a = useApp();
  const [ctl, setCtl] = useState<SessionController | undefined>(live.get(sessionId));
  const [error, setError] = useState<string>();
  const trying = useRef(false);

  useEffect(() => { setCtl(live.get(sessionId)); setError(undefined); }, [sessionId]);

  const cwd = a.sessions.find((s) => s.id === sessionId)?.cwd;
  const phase = useSyncExternalStore(ctl?.subscribe ?? noopSubscribe, () => ctl?.getSnapshot().phase);
  const down = phase === "disconnected";
  useEffect(() => {
    if ((ctl && !down) || trying.current || a.daemon.state !== "running" || !cwd) return;
    trying.current = true;
    SessionController.resume(sessionId, cwd).then((c) => { live.set(sessionId, c); setCtl(c); setError(undefined); }, (e) => setError((e as Error).message)).finally(() => { trying.current = false; });
  }, [ctl, down, a.daemon.state, cwd, sessionId]);
  useEffect(() => { if (!cwd && a.daemon.state === "running" && !ctl) void app.refresh(); }, [cwd, a.daemon.state, ctl]);
  return { ctl, error };
}
const noopSubscribe = () => () => {};

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const { ctl, error } = useController(sessionId);
  if (!ctl) return <div className="center-note">{error ? `Could not open this session: ${error}` : "Opening session"}</div>;
  return <Loaded key={ctl.getSnapshot().sessionId ?? sessionId} ctl={ctl} />;
}

function Loaded({ ctl }: { ctl: SessionController }) {
  const state = useStore(ctl);
  const a = useApp();
  const [paneOpen, setPaneOpen] = useState(false);
  const [tab, setTab] = useState<PaneTab>("files");
  const [mounted, setMounted] = useState<Set<PaneTab>>(new Set(["browser"])); // the browser stays mounted so the agent can drive it
  const [maximized, setMaximized] = useState(false);
  const [prefill, setPrefill] = useState<string>();
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const off = a.settings?.disabledShortcuts ?? [];

  const showTab = useCallback((t: PaneTab) => { setMounted((m) => new Set(m).add(t)); setTab(t); setPaneOpen(true); }, []);

  useEffect(() => { if (state.phase === "ready") void ctl.attachBrowser(); }, [ctl, state.phase]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      for (const k of PANE_KEYS) if (k.test(e) && !off.includes(k.id)) { e.preventDefault(); if (paneOpen && tab === k.tab && k.tab !== "files") setPaneOpen(false); else showTab(k.tab); return; }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); setPaneOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [paneOpen, tab, showTab, off]);

  const say = (t: string) => { setToast(t); setTimeout(() => setToast(""), 1600); };
  const copy = async (t: string, what: string) => { await navigator.clipboard.writeText(t).catch(() => {}); say(`Copied ${what}`); setMenu(false); };
  const id = state.sessionId ?? "";

  if (state.phase === "error") return <div className="center-note">Could not connect: {state.error}</div>;

  return (
    <div className="session">
      <div className="session-main">
        <header className="session-head">
          <h1 title={state.cwd}>{state.title}</h1>
          <span className="muted cwd">{state.cwd}</span>
          <span className="spacer" />
          {state.phase === "disconnected" && <span className="badge warn">Reconnecting</span>}
          <button aria-label="Toggle tools panel" onClick={() => setPaneOpen(!paneOpen)} title="Tools panel (Alt+Ctrl+B)">Tools</button>
          <div className="chip-wrap">
            <button aria-label="Session menu" aria-haspopup="menu" onClick={() => setMenu(!menu)}>...</button>
            {menu && (
              <div className="menu right" role="menu">
                <button role="menuitem" className="menu-item" onClick={() => { showTab("terminal"); setMenu(false); }}>Open terminal</button>
                <button role="menuitem" className="menu-item" onClick={() => void copy(state.cwd, "working folder")}>Copy working folder</button>
                <button role="menuitem" className="menu-item" onClick={() => void copy(id, "session id")}>Copy session id</button>
                <button role="menuitem" className="menu-item" onClick={() => void copy(`rigwell://sessions/${id}`, "session link")}>Copy session link</button>
                <button role="menuitem" className="menu-item" onClick={() => void copy(toMarkdown(state.items), "as Markdown")}>Copy as Markdown</button>
              </div>
            )}
          </div>
        </header>
        <Transcript items={state.items} working={state.working} />
        <Prompts prompts={state.prompts} onAnswer={(rid, r) => ctl.answer(rid, r)} />
        <Composer
          settings={state.settings} models={state.models.length ? state.models : a.models} busy={state.working !== "idle"} disabled={state.phase !== "ready"}
          disabledShortcuts={off} autoFocus placeholder="Message the agent"
          onChange={(p) => void ctl.updateSettings({ ...p })} onSend={(t) => void ctl.send(t)} onStop={() => ctl.interrupt()}
          extra={<button className="chip" onClick={() => { const last = [...state.items].reverse().find((i) => i.kind === "assistant"); setPrefill(last && last.kind === "assistant" ? `About this: "${last.text.slice(0, 200)}"\n\n` : ""); showTab("side"); }}>Side chat</button>}
        />
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
      <div className={paneOpen ? "pane-slot open" : "pane-slot"} hidden={!paneOpen}>
        <SidePane
          ctl={ctl} state={state} tab={tab} mounted={mounted} maximized={maximized} autoOpenPreviews={a.settings?.autoOpenFilePreviews ?? true}
          prefill={prefill} onPrefillUsed={() => setPrefill(undefined)} onTab={showTab} onClose={() => setPaneOpen(false)} onMaximize={() => setMaximized(!maximized)}
        />
      </div>
    </div>
  );
}


