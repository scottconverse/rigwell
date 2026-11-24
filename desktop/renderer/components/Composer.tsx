import { useEffect, useRef, useState } from "react";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import type { SessionController } from "../lib/session.ts";
import type { QueuedMessage, QueuePlacement } from "../lib/queued.ts";
import { ConnectorsDialog, SkillsDialog } from "./Dialogs.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ICONS24, NavIcon } from "./NavIcon.tsx";
import { DictateButton } from "./DictateButton.tsx";
import { MAX_ATTACHMENTS, defaultText, readAttachment, sizeLabel, type Attachment } from "../lib/attachments.ts";

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
  onSend(text: string, attachments?: Attachment[], placement?: QueuePlacement): void;
  onStop(): void;
  /** Messages that wait for the agent, shown above the input. */
  queued?: QueuedMessage[];
  extra?: React.ReactNode;
  /** The live session, when there is one: enables the Connectors dialog. */
  session?: SessionController;
  /** Folder used by the Skills dialog. */
  cwd?: string;
  autoAvailable?: boolean;
  pinnedModels?: string[];
  /** Mode chip: Mission was chosen. */
  onMission?(): void;
  prefill?: string;
  onPrefillUsed?(): void;
  /** A message taken back out of the send queue: its text and attachments go into the composer. */
  restore?: { text: string; attachments?: Attachment[]; nonce: number };
  onRestoreUsed?(): void;
}) {
  const [text, setText] = useState("");
  const [help, setHelp] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [dialog, setDialog] = useState<"connectors" | "skills" | null>(null);
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const lastEsc = useRef(0);
  const keyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const pasteRef = useRef<(files: FileList) => boolean>(() => false);
  const off = (id: string) => props.disabledShortcuts?.includes(id);
  const s = props.settings;

  // The composer is a tiptap editor kept to plain text (paragraphs, soft line breaks, undo): rich pasted content collapses to text.
  const editor = useEditor({
    extensions: [Document, Paragraph, Text, HardBreak, UndoRedo, Placeholder.configure({ placeholder: props.placeholder ?? "What would you like to work on?" })],
    editorProps: {
      attributes: { "aria-label": "Message", role: "textbox", "aria-multiline": "true", class: "composer-editor" },
      handleKeyDown: (_v, e) => keyRef.current(e),
      handlePaste: (_v, e) => { const f = e.clipboardData?.files; return !!f && f.length > 0 && pasteRef.current(f); },
    },
    onUpdate: ({ editor: ed }) => setText(ed.getText({ blockSeparator: "\n" })),
    autofocus: false,
  });
  useEffect(() => {
    if (!editor || !props.prefill) return;
    editor.chain().focus("end").insertContent({ type: "text", text: `${editor.isEmpty ? "" : "\n"}${props.prefill}` }).run();
    props.onPrefillUsed?.();
  }, [editor, props.prefill]);
  useEffect(() => {
    const r = props.restore;
    if (!editor || !r) return;
    if (r.text) editor.chain().focus("end").insertContent({ type: "text", text: `${editor.isEmpty ? "" : "\n"}${r.text}` }).run();
    if (r.attachments?.length) {
      const room = Math.max(0, MAX_ATTACHMENTS - atts.length);
      if (r.attachments.length > room) setAttachError(`At most ${MAX_ATTACHMENTS} attachments; ${r.attachments.length - room} did not fit.`);
      setAtts((cur) => [...cur, ...r.attachments!.slice(0, Math.max(0, MAX_ATTACHMENTS - cur.length))]);
    }
    props.onRestoreUsed?.();
    // Restore once per request; the nonce changes when a new message is put back.
  }, [editor, props.restore]);
  useEffect(() => {
    if (!props.autoFocus || !editor) return;
    const initialFocus = document.activeElement;
    if (initialFocus && initialFocus !== document.body && initialFocus.tagName !== "BUTTON") return;
    // Check at delivery time: mount autofocus must not steal a field the user selected.
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed && (!document.activeElement || document.activeElement === document.body || document.activeElement === initialFocus)) editor.view.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocus, editor]);
  const clearText = () => { editor?.commands.clearContent(true); setText(""); };

  const cycle = (list: string[], cur: string | undefined) => list[(Math.max(0, list.indexOf(cur ?? "")) + 1) % list.length];
  const send = (placement?: QueuePlacement) => {
    const t = (editor ? editor.getText({ blockSeparator: "\n" }) : text).trim();
    if ((!t && !atts.length) || props.disabled) return;
    props.onSend(t || defaultText(atts), atts.length ? atts : undefined, placement);
    clearText(); setAtts([]); setAttachError("");
  };

  /** Picked, pasted or dropped files (spec 14.3). Unsupported or oversized ones are reported, the rest are kept. */
  const attach = async (files: ArrayLike<File>) => {
    const errors: string[] = [];
    const added: Attachment[] = [];
    for (const f of Array.from(files)) {
      if (atts.length + added.length >= MAX_ATTACHMENTS) { errors.push(`At most ${MAX_ATTACHMENTS} attachments`); break; }
      const r = await readAttachment(f);
      if (r.ok) added.push(r.attachment); else errors.push(`${r.name} ${r.error}`);
    }
    if (added.length) setAtts((cur) => [...cur, ...added]);
    setAttachError(errors.join(". "));
  };

  pasteRef.current = (files) => { void attach(files); return true; };
  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    if (e.dataTransfer?.files?.length) { e.preventDefault(); void attach(e.dataTransfer.files); }
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(props.busy ? (e.ctrlKey ? "end_of_loop" : "end_of_turn") : undefined); return true; }
    if (e.key === "Escape") {
      e.preventDefault();
      const now = Date.now();
      if (props.busy) props.onStop();
      else if (now - lastEsc.current < 600) clearText();
      lastEsc.current = now;
      return true;
    }
    const composerShortcut = e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey;
    if (composerShortcut && e.key.toLowerCase() === "m" && !off("spec")) { e.preventDefault(); props.onChange({ interactionMode: s.interactionMode === "spec" ? "auto" : "spec" }); return true; }
    if (composerShortcut && e.key.toLowerCase() === "r" && !off("reasoning")) { e.preventDefault(); props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) }); return true; }
    if (e.key === "l" && e.ctrlKey && !off("autonomy")) { e.preventDefault(); props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) }); return true; }
    if (e.key === "?" && !(editor?.getText() ?? text)) { e.preventDefault(); setHelp(true); return true; }
    return false;
  };
  keyRef.current = onKey;


  return (
    <div className={dragging ? "composer dragging" : "composer"} data-ready={!props.disabled}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {!!props.queued?.length && (
        <section className="waiting" aria-label="Waiting list">
          <div className="waiting-head">Waiting ({props.queued.length})</div>
          <ol className="waiting-list">
            {props.queued.map((m) => <li key={m.messageId} className="waiting-item" title={m.text}>{m.text}</li>)}
          </ol>
        </section>
      )}
      {(atts.length > 0 || attachError) && (
        <div className="attachments" aria-label="Attachments">
          {atts.map((a) => (
            <span key={a.id} className="attachment">
              {a.kind === "image" && <img alt="" src={`data:${a.mediaType};base64,${a.data}`} />}
              <span className="attachment-name" title={a.name}>{a.name}</span><span className="muted small"> {sizeLabel(a.size)}</span>
              <button aria-label={`Remove ${a.name}`} onClick={() => setAtts(atts.filter((x) => x.id !== a.id))}>x</button>
            </span>
          ))}
          {attachError && <span className="attach-error" role="alert">{attachError}</span>}
        </div>
      )}
      <EditorContent editor={editor} className="composer-input" />
      <input ref={picker} type="file" multiple hidden data-testid="attach-input" aria-label="Choose files to attach" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.ts,.tsx,.js,.json,.py,.go,.rs,.txt,.csv,.yml,.yaml,.toml"
        onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = ""; }} />
      <div className="chips">
        <ModelPicker models={props.models} value={s.modelId} autoAvailable={props.autoAvailable} pinned={props.pinnedModels} onPick={(id) => props.onChange({ modelId: id })} />
        <button className="chip" title={AUTONOMY_TIPS[s.autonomyLevel ?? "off"]} onClick={() => props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) })}>
          Autonomy: {s.autonomyLevel ?? "off"}
        </button>
        <div className="chip-wrap">
          <button className="chip" aria-haspopup="menu" aria-expanded={modeOpen} title="Mode: Normal, Spec (Ctrl+Alt+M) or Mission" onClick={() => setModeOpen(!modeOpen)}>{MODE_LABEL[s.interactionMode ?? "auto"] ?? "Normal"}</button>
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
        <button className="chip" title="Reasoning (Ctrl+Alt+R)" onClick={() => props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) })}>Reasoning: {s.reasoningEffort ?? "high"}</button>
        {props.session && <button className="chip" onClick={() => setDialog("connectors")} title="MCP servers">Connectors</button>}
        <button className="chip" onClick={() => setDialog("skills")} title="Skills">Skills</button>
        <DictateButton shortcut={!off("dictation")} disabled={props.disabled} onText={(t) => { editor?.chain().focus().insertContent(t).run(); setText(editor?.getText({ blockSeparator: "\n" }) ?? t); }} />
        <button className="chip" aria-label="Attach files" title="Attach images, PDFs or text files (you can also paste or drop them)" onClick={() => picker.current?.click()}>Attach</button>
        {props.extra}
        <span className="spacer" />
        {props.busy
          ? <button className="send stop" onClick={props.onStop} aria-label="Stop"><NavIcon d={ICONS24.stop} grid={24} size={16} /></button>
          : <button className="send" disabled={(!text.trim() && !atts.length) || props.disabled} onClick={() => send()} aria-label="Send"><NavIcon d={ICONS24.send} grid={24} size={16} /></button>}
      </div>
      {dialog === "connectors" && props.session && <ConnectorsDialog ctl={props.session} onClose={() => setDialog(null)} />}
      {dialog === "skills" && <SkillsDialog ctl={props.session} cwd={props.cwd ?? ""} onClose={() => setDialog(null)} />}
      {help && (
        <div className="overlay" onClick={() => setHelp(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Shortcuts and modes">
            <h3>Shortcuts and modes</h3>
            <ul>
              <li><kbd>Enter</kbd> send, <kbd>Shift+Enter</kbd> new line</li>
              <li>During a turn: <kbd>Enter</kbd> adds to the waiting list, <kbd>Ctrl+Enter</kbd> delivers after the current tool step</li>
              <li><kbd>Esc</kbd> stop, <kbd>Esc Esc</kbd> clear</li>
              <li><kbd>Ctrl+Alt+M</kbd> toggle Spec mode, <kbd>Ctrl+Alt+R</kbd> cycle reasoning, <kbd>Ctrl+L</kbd> cycle autonomy</li>
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
