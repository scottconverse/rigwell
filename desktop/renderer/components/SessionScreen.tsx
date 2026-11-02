import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { app, useApp, useStore } from "../lib/app-model.ts";
import { SessionController } from "../lib/session.ts";
import { toMarkdown } from "../lib/transcript.ts";
import { readinessText } from "../lib/missions.ts";
import { Composer } from "./Composer.tsx";
import { toParams } from "../lib/attachments.ts";
import { ConfirmDialog, TextDialog } from "./Dialogs.tsx";
import { Prompts } from "./Prompts.tsx";
import { SidePane, type PaneTab } from "./SidePane.tsx";
import { Transcript } from "./Transcript.tsx";

/** Controllers for sessions created in this window, so Home can hand one over without reconnecting. */
export const live = new Map<string, SessionController>();
/** Sessions started from Home with the Mission mode chip: enter mission mode once the session is on screen (spec §15.1). */
export const pendingMission = new Set<string>();

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

  const row = a.sessions.find((s) => s.id === sessionId);
  const cwd = row?.cwd;
  const phase = useSyncExternalStore(ctl?.subscribe ?? noopSubscribe, () => ctl?.getSnapshot().phase);
  const down = phase === "disconnected";
  useEffect(() => {
    if ((ctl && !down) || trying.current || a.daemon.state !== "running" || !cwd) return;
    trying.current = true;
    SessionController.resume(sessionId, cwd, { title: row?.title, pinned: row?.pinned, archived: row?.archivedAt != null }).then((c) => { live.set(sessionId, c); setCtl(c); setError(undefined); }, (e) => setError((e as Error).message)).finally(() => { trying.current = false; });
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
  const [dialog, setDialog] = useState<null | "rename" | { readiness: string }>(null);
  const off = a.settings?.disabledShortcuts ?? [];

  /** Mode chip: Mission. The readiness check runs first; a folder that is not ready asks before going on (spec §15.7). */
  const enterMission = useCallback(async (anyway = false) => {
    try {
      const r = await ctl.enterMission(anyway);
      if (!r.entered) setDialog({ readiness: readinessText(r.readiness) }); else { setDialog(null); setToast(r.modelSwitched ? "Mission mode on; switched to the orchestrator model" : "Mission mode on"); setTimeout(() => setToast(""), 2200); }
    } catch (e) { setToast((e as Error).message); setTimeout(() => setToast(""), 3000); }
  }, [ctl]);
  const sid = state.sessionId;
  useEffect(() => { if (state.phase === "ready" && sid && pendingMission.delete(sid)) void enterMission(); }, [state.phase, sid, enterMission]);

  // Approved spec handoff (spec 5.5.7): the old turn ended with reason spec_handoff; this client opens the new session.
  useEffect(() => ctl.onHandoff((specHandoffId) => {
    void (async () => {
      try {
        const next = await SessionController.create({ cwd: ctl.getSnapshot().cwd, specHandoffId });
        const nid = next.getSnapshot().sessionId!;
        live.set(nid, next);
        void app.refresh();
        window.location.hash = `/sessions/${nid}`;
      } catch (e) { setToast(`Could not start the new session: ${(e as Error).message}`); setTimeout(() => setToast(""), 4000); }
    })();
  }), [ctl]);

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
  /** Header menu actions use the contract methods; the sidebar list is refreshed afterwards. */
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMenu(false);
    try { await fn(); say(done); void app.refresh(); } catch (e) { say((e as Error).message); }
  };

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
                <button role="menuitem" className="menu-item" onClick={() => void act(() => ctl.setPinned(!state.pinned), state.pinned ? "Unpinned" : "Pinned")}>{state.pinned ? "Unpin" : "Pin"}</button>
                <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); setDialog("rename"); }}>Rename</button>
                <button role="menuitem" className="menu-item" onClick={() => void act(() => ctl.setArchived(!state.archived), state.archived ? "Unarchived" : "Archived")}>{state.archived ? "Unarchive" : "Archive"}</button>
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
          disabledShortcuts={off} autoFocus placeholder="Message the agent" session={ctl} cwd={state.cwd} autoAvailable={!!a.userSettings.autoRouter} onMission={() => void enterMission()}
          onChange={(p) => void ctl.updateSettings({ ...p })} onSend={(t, atts) => void ctl.send(t, atts ? toParams(atts) : {})} onStop={() => ctl.interrupt()}
          extra={<button className="chip" onClick={() => { const last = [...state.items].reverse().find((i) => i.kind === "assistant"); setPrefill(last && last.kind === "assistant" ? `About this: "${last.text.slice(0, 200)}"\n\n` : ""); showTab("side"); }}>Side chat</button>}
        />
        {toast && <div className="toast" role="status">{toast}</div>}
        {dialog === "rename" && <TextDialog title="Rename session" label="Title" initial={state.title} action="Rename" onCancel={() => setDialog(null)} onSubmit={(v) => { setDialog(null); void act(() => ctl.rename(v), "Renamed"); }} />}
        {dialog && typeof dialog === "object" && <ConfirmDialog title="This folder is not ready for a mission" body={`${dialog.readiness}\n\nYou can continue anyway.`} action="Continue anyway" onCancel={() => setDialog(null)} onConfirm={() => void enterMission(true)} />}
      </div>
      <div className={paneOpen ? "pane-slot open" : "pane-slot"} hidden={!paneOpen}>
        <SidePane
          ctl={ctl} state={state} tab={tab} mounted={mounted} maximized={maximized} autoOpenPreviews={a.settings?.autoOpenFilePreviews ?? true}
          prefill={prefill} onPrefillUsed={() => setPrefill(undefined)} onPromoted={(sid) => { void app.refresh(); window.location.hash = `/sessions/${sid}`; }} onTab={showTab} onClose={() => setPaneOpen(false)} onMaximize={() => setMaximized(!maximized)}
        />
      </div>
    </div>
  );
}


