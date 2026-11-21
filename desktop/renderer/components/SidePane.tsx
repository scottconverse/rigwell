// The side pane (spec §17): Files, Terminal, Browser and Side chat. Tabs that have been opened stay mounted so a
// terminal keeps its state and the browser stays drivable while another tab is showing.
import { useState } from "react";
import type { SessionController, SessionState } from "../lib/session.ts";
import { AgentsTab } from "./AgentsTab.tsx";
import { BrowserTab } from "./BrowserTab.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { SideChatTab } from "./SideChatTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { RemoteViewer } from "./RemoteViewer.tsx";

export type PaneTab = "files" | "terminal" | "browser" | "side" | "agents" | "desktop";
const LABELS: Record<PaneTab, string> = { files: "Files", terminal: "Terminal", browser: "Browser", side: "Side chat", agents: "Agents", desktop: "Remote desktop" };
const KEYS: Partial<Record<PaneTab, string>> = { files: "Ctrl+P", terminal: "Ctrl+J", browser: "Shift+Ctrl+B", side: "Alt+Ctrl+S" };

export function SidePane(props: {
  ctl: SessionController; state: SessionState; tab: PaneTab; mounted: Set<PaneTab>; maximized: boolean; autoOpenPreviews: boolean;
  prefill?: string; onPrefillUsed(): void; onPromoted(sessionId: string): void; onTab(t: PaneTab): void; onClose(): void; onMaximize(): void;
}) {
  const { ctl, state, tab, mounted } = props;
  const [fileToOpen] = useState<string | undefined>();
  const show = (t: PaneTab) => ({ display: tab === t ? "flex" : "none" });
  return (
    <aside className={`sidepane ${props.maximized ? "max" : ""}`} aria-label="Tools panel" data-testid="sidepane">
      <div className="pane-tabs" role="tablist">
        {(Object.keys(LABELS) as PaneTab[]).filter((t) => t !== "desktop" || state.machine).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} title={KEYS[t] ? `${LABELS[t]} (${KEYS[t]})` : LABELS[t]} onClick={() => props.onTab(t)}>{LABELS[t]}</button>
        ))}
        <span className="spacer" />
        <button onClick={props.onMaximize} aria-label="Maximize">{props.maximized ? "Restore" : "Maximize"}</button>
        <button onClick={props.onClose} aria-label="Close tools panel">Close</button>
      </div>
      <div className="pane-body">
        {mounted.has("files") && <div className="pane-page" style={show("files")}><FilesTab ctl={ctl} autoOpen={props.autoOpenPreviews} requestOpen={fileToOpen} refreshKey={state.working === "idle" ? 1 : 0} /></div>}
        {mounted.has("terminal") && <div className="pane-page" style={show("terminal")}><TerminalTab ctl={ctl} active={tab === "terminal"} /></div>}
        {mounted.has("browser") && <div className="pane-page" style={show("browser")}>{state.machine ? <RemoteViewer key={state.sessionId} machine={state.machine} kind="browser" visible={tab === "browser"} /> : <BrowserTab key={state.sessionId} sessionId={state.sessionId} visible={tab === "browser"} onWantVisible={() => props.onTab("browser")} />}</div>}
        {mounted.has("desktop") && state.machine && <div className="pane-page" style={show("desktop")}><RemoteViewer key={state.sessionId} machine={state.machine} kind="desktop" visible={tab === "desktop"} /></div>}
        {mounted.has("side") && <div className="pane-page" style={show("side")}><SideChatTab ctl={ctl} entries={state.sideChat} writes={state.sideWrites} prefill={props.prefill} onPrefillUsed={props.onPrefillUsed} onPromoted={props.onPromoted} /></div>}
        {mounted.has("agents") && <div className="pane-page" style={show("agents")}><AgentsTab key={state.sessionId} ctl={ctl} sessionId={state.sessionId} active={tab === "agents"} /></div>}
      </div>
    </aside>
  );
}
