import { useEffect, useRef, useState } from "react";
import type { SessionController } from "../lib/session.ts";
import { ConnectorsDialog, SkillsDialog } from "./Dialogs.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const MODES = [
  { id: "auto", label: "Normal", hint: "do the work directly" },
  { id: "spec", label: "Spec", hint: "research and plan before changes" },
  { id: "mission", label: "Mission", hint: "long jobs with parallel workers" },
];
const MODE_LABEL: Record<string, string> = { auto: "Normal", spec: "Spec", mission: "Mission" };

export interface ComposerSettings { modelId?: string; reasoningEffort?: string; interactionMode?: string; autonomyLevel?: string }

const AUTONOMY = ["low", "medium", "high"]; // clicking cycles these and skips Off (spec §14.3)
const AUTONOMY_TIPS: Record<string, string> = {
  off: "Asks before every edit and command",
  low: "Edits and read-only commands run without asking",
  medium: "Reversible commands run without asking",
  high: "All commands run without asking",
};
const REASONING = ["off", "low", "medium", "high"];

export function Composer(props: {
  settings: ComposerSettings;
  models: { id: string; displayName?: string; provider?: string }[];
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabledShortcuts?: string[];
  onChange(patch: ComposerSettings): void;
  onSend(text: string): void;
  onStop(): void;
  extra?: React.ReactNode;
  /** The live session, when there is one: enables the Connectors dialog. */
  session?: SessionController;
  /** Folder used by the Skills dialog. */
  cwd?: string;
  autoAvailable?: boolean;
  pinnedModels?: string[];
  /** Mode chip: Mission was chosen. */
  onMission?(): void;
}) {
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [dialog, setDialog] = useState<"connectors" | "skills" | null>(null);
  const lastEsc = useRef(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const off = (id: string) => props.disabledShortcuts?.includes(id);
  const s = props.settings;

  useEffect(() => { if (props.autoFocus) ta.current?.focus(); }, [props.autoFocus]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(220, el.scrollHeight) + "px"; } }, [text]);

  const cycle = (list: string[], cur: string | undefined) => list[(Math.max(0, list.indexOf(cur ?? "")) + 1) % list.length];
  const send = () => { const t = text.trim(); if (!t || props.disabled) return; props.onSend(t); setText(""); };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      const now = Date.now();
      if (props.busy) props.onStop();
      else if (now - lastEsc.current < 600) setText("");
      lastEsc.current = now;
      return;
    }
    if (e.key === "Tab" && e.shiftKey && !off("spec")) { e.preventDefault(); props.onChange({ interactionMode: s.interactionMode === "spec" ? "auto" : "spec" }); return; }
    if (e.key === "Tab" && !e.shiftKey && !off("reasoning")) { e.preventDefault(); props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) }); return; }
    if (e.key === "l" && e.ctrlKey && !off("autonomy")) { e.preventDefault(); props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) }); return; }
    if (e.key === "?" && !text) { e.preventDefault(); setHelp(true); }
  };


  return (
    <div className="composer" data-ready={!props.disabled}>
      <textarea ref={ta} value={text} rows={2} placeholder={props.placeholder ?? "What would you like to work on?"} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Message" />
      <div className="chips">
        <ModelPicker models={props.models} value={s.modelId} autoAvailable={props.autoAvailable} pinned={props.pinnedModels} onPick={(id) => props.onChange({ modelId: id })} />
        <button className="chip" title={AUTONOMY_TIPS[s.autonomyLevel ?? "off"]} onClick={() => props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) })}>
          Autonomy: {s.autonomyLevel ?? "off"}
        </button>
        <div className="chip-wrap">
          <button className="chip" aria-haspopup="menu" aria-expanded={modeOpen} title="Mode: Normal, Spec (Shift+Tab) or Mission" onClick={() => setModeOpen(!modeOpen)}>{MODE_LABEL[s.interactionMode ?? "auto"] ?? "Normal"}</button>
          {modeOpen && (
            <div className="menu" role="menu" aria-label="Mode">
              {MODES.map((m) => (
                <button key={m.id} role="menuitemradio" aria-checked={(s.interactionMode ?? "auto") === m.id} className="menu-item" onClick={() => { setModeOpen(false); if (m.id === "mission") props.onMission?.(); else props.onChange({ interactionMode: m.id }); }}>
                  {m.label}<span className="muted small"> {m.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="chip" title="Reasoning (Tab)" onClick={() => props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) })}>Reasoning: {s.reasoningEffort ?? "high"}</button>
        {props.session && <button className="chip" onClick={() => setDialog("connectors")} title="MCP servers">Connectors</button>}
        <button className="chip" onClick={() => setDialog("skills")} title="Skills">Skills</button>
        {props.extra}
        <span className="spacer" />
        {props.busy
          ? <button className="send stop" onClick={props.onStop} aria-label="Stop">Stop</button>
          : <button className="send" disabled={!text.trim() || props.disabled} onClick={send} aria-label="Send">Send</button>}
      </div>
      {dialog === "connectors" && props.session && <ConnectorsDialog ctl={props.session} onClose={() => setDialog(null)} />}
      {dialog === "skills" && <SkillsDialog ctl={props.session} cwd={props.cwd ?? ""} onClose={() => setDialog(null)} />}
      {help && (
        <div className="overlay" onClick={() => setHelp(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Shortcuts and modes">
            <h3>Shortcuts and modes</h3>
            <ul>
              <li><kbd>Enter</kbd> send, <kbd>Shift+Enter</kbd> new line</li>
              <li><kbd>Esc</kbd> stop, <kbd>Esc Esc</kbd> clear</li>
              <li><kbd>Shift+Tab</kbd> toggle Spec mode, <kbd>Tab</kbd> cycle reasoning, <kbd>Ctrl+L</kbd> cycle autonomy</li>
              <li><kbd>Ctrl+K</kbd> palette, <kbd>Ctrl+P</kbd> files, <kbd>Ctrl+J</kbd> terminal, <kbd>Shift+Ctrl+B</kbd> browser, <kbd>Alt+Ctrl+S</kbd> side chat</li>
            </ul>
            <p className="muted">Autonomy: {Object.entries(AUTONOMY_TIPS).map(([k, v]) => `${k}: ${v}`).join(". ")}.</p>
            <button onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
