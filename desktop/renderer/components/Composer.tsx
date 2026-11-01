import { useEffect, useRef, useState } from "react";

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
}) {
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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

  const model = props.models.find((m) => m.id === s.modelId);
  const grouped = props.models.reduce<Record<string, typeof props.models>>((acc, m) => { (acc[m.provider ?? "other"] ??= []).push(m); return acc; }, {});

  return (
    <div className="composer">
      <textarea ref={ta} value={text} rows={2} placeholder={props.placeholder ?? "What would you like to work on?"} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Message" />
      <div className="chips">
        <div className="chip-wrap">
          <button className="chip" onClick={() => setModelOpen(!modelOpen)} aria-haspopup="listbox" title="Model">{model?.displayName ?? s.modelId ?? "Model"}</button>
          {modelOpen && (
            <div className="menu model-menu" role="listbox">
              {Object.entries(grouped).map(([prov, ms]) => (
                <div key={prov}>
                  <div className="menu-group">{prov}</div>
                  {ms.map((m) => <button key={m.id} role="option" aria-selected={m.id === s.modelId} className="menu-item" onClick={() => { props.onChange({ modelId: m.id }); setModelOpen(false); }}>{m.displayName ?? m.id}</button>)}
                </div>
              ))}
              {!props.models.length && <div className="menu-group">No models configured</div>}
            </div>
          )}
        </div>
        <button className="chip" title={AUTONOMY_TIPS[s.autonomyLevel ?? "off"]} onClick={() => props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) })}>
          Autonomy: {s.autonomyLevel ?? "off"}
        </button>
        <button className="chip" title="Normal or Spec mode (Shift+Tab)" onClick={() => props.onChange({ interactionMode: s.interactionMode === "spec" ? "auto" : "spec" })}>{s.interactionMode === "spec" ? "Spec" : "Normal"}</button>
        <button className="chip" title="Reasoning (Tab)" onClick={() => props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) })}>Reasoning: {s.reasoningEffort ?? "high"}</button>
        {props.extra}
        <span className="spacer" />
        {props.busy
          ? <button className="send stop" onClick={props.onStop} aria-label="Stop">Stop</button>
          : <button className="send" disabled={!text.trim() || props.disabled} onClick={send} aria-label="Send">Send</button>}
      </div>
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
