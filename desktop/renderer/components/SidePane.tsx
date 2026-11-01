// The side pane (spec §17): Files, Terminal, Browser and Side chat. Tabs that have been opened stay mounted so a
// terminal keeps its state and the browser stays drivable while another tab is showing.
import { useState } from "react";
import type { SessionController, SessionState } from "../lib/session.ts";
import { BrowserTab } from "./BrowserTab.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { SideChatTab } from "./SideChatTab.tsx";
import { TerminalTab } from "./TerminalTab.tsx";

export type PaneTab = "files" | "terminal" | "browser" | "side";
const LABELS: Record<PaneTab, string> = { files: "Files", terminal: "Terminal", browser: "Browser", side: "Side chat" };
const KEYS: Record<PaneTab, string> = { files: "Ctrl+P", terminal: "Ctrl+J", browser: "Shift+Ctrl+B", side: "Alt+Ctrl+S" };

export function SidePane(props: {
  ctl: SessionController; state: SessionState; tab: PaneTab; mounted: Set<PaneTab>; maximized: boolean; autoOpenPreviews: boolean;
  prefill?: string; onPrefillUsed(): void; onTab(t: PaneTab): void; onClose(): void; onMaximize(): void;
}) {
  const { ctl, state, tab, mounted } = props;
  const [fileToOpen] = useState<string | undefined>();
  const show = (t: PaneTab) => ({ display: tab === t ? "flex" : "none" });
  return (
    <aside className={`sidepane ${props.maximized ? "max" : ""}`} aria-label="Tools panel" data-testid="sidepane">
      <div className="pane-tabs" role="tablist">
        {(Object.keys(LABELS) as PaneTab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} title={`${LABELS[t]} (${KEYS[t]})`} onClick={() => props.onTab(t)}>{LABELS[t]}</button>
        ))}
        <span className="spacer" />
        <button onClick={props.onMaximize} aria-label="Maximize">{props.maximized ? "Restore" : "Maximize"}</button>
        <button onClick={props.onClose} aria-label="Close tools panel">Close</button>
      </div>
      <div className="pane-body">
        {mounted.has("files") && <div className="pane-page" style={show("files")}><FilesTab ctl={ctl} autoOpen={props.autoOpenPreviews} requestOpen={fileToOpen} refreshKey={state.working === "idle" ? 1 : 0} /></div>}
        {mounted.has("terminal") && <div className="pane-page" style={show("terminal")}><TerminalTab ctl={ctl} active={tab === "terminal"} /></div>}
        {mounted.has("browser") && <div className="pane-page" style={show("browser")}><BrowserTab visible={tab === "browser"} onWantVisible={() => props.onTab("browser")} /></div>}
        {mounted.has("side") && <div className="pane-page" style={show("side")}><SideChatTab ctl={ctl} entries={state.sideChat} prefill={props.prefill} onPrefillUsed={props.onPrefillUsed} /></div>}
      </div>
    </aside>
  );
}
