import { useEffect, useRef, useState } from "react";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import type { SessionController } from "../lib/session.ts";
import { ConnectorsDialog, SkillsDialog } from "./Dialogs.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { DictateButton } from "./DictateButton.tsx";
import { ImagePreview } from "./ImagePreview.tsx";
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
  onSend(text: string, attachments?: Attachment[]): void;
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
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAtt = atts.find((a) => a.id === previewId && a.kind === "image");
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
    autofocus: !!props.autoFocus,
  });
  useEffect(() => { if (props.autoFocus) editor?.commands.focus(); }, [props.autoFocus, editor]);
  const clearText = () => { editor?.commands.clearContent(true); setText(""); };

  const cycle = (list: string[], cur: string | undefined) => list[(Math.max(0, list.indexOf(cur ?? "")) + 1) % list.length];
  const send = () => {
    const t = (editor ? editor.getText({ blockSeparator: "\n" }) : text).trim();
    if ((!t && !atts.length) || props.disabled) return;
    props.onSend(t || defaultText(atts), atts.length ? atts : undefined);
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
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); return true; }
    if (e.key === "Escape") {
      e.preventDefault();
      const now = Date.now();
      if (props.busy) props.onStop();
      else if (now - lastEsc.current < 600) clearText();
      lastEsc.current = now;
      return true;
    }
    if (e.key === "Tab" && e.shiftKey && !off("spec")) { e.preventDefault(); props.onChange({ interactionMode: s.interactionMode === "spec" ? "auto" : "spec" }); return true; }
    if (e.key === "Tab" && !e.shiftKey && !off("reasoning")) { e.preventDefault(); props.onChange({ reasoningEffort: cycle(REASONING, s.reasoningEffort) }); return true; }
    if (e.key === "l" && e.ctrlKey && !off("autonomy")) { e.preventDefault(); props.onChange({ autonomyLevel: cycle(AUTONOMY, s.autonomyLevel === "off" ? "high" : s.autonomyLevel) }); return true; }
    if (e.key === "?" && !(editor?.getText() ?? text)) { e.preventDefault(); setHelp(true); return true; }
    return false;
  };
  keyRef.current = onKey;


  return (
    <div className={dragging ? "composer dragging" : "composer"} data-ready={!props.disabled}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {(atts.length > 0 || attachError) && (
        <div className="attachments" aria-label="Attachments">
          {atts.map((a) => (
            <span key={a.id} className="attachment">
              {a.kind === "image" && <button className="thumb" aria-label={`Preview ${a.name}`} title="Click to preview" onClick={() => setPreviewId(a.id)}><img alt="" src={`data:${a.mediaType};base64,${a.data}`} /></button>}
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
        <DictateButton shortcut={!off("dictation")} disabled={props.disabled} onText={(t) => { editor?.chain().focus().insertContent(t).run(); setText(editor?.getText({ blockSeparator: "\n" }) ?? t); }} />
        <button className="chip" aria-label="Attach files" title="Attach images, PDFs or text files (you can also paste or drop them)" onClick={() => picker.current?.click()}>Attach</button>
        {props.extra}
        <span className="spacer" />
        {props.busy
          ? <button className="send stop" onClick={props.onStop} aria-label="Stop">Stop</button>
          : <button className="send" disabled={(!text.trim() && !atts.length) || props.disabled} onClick={send} aria-label="Send">Send</button>}
      </div>
      {previewAtt && <ImagePreview src={`data:${previewAtt.mediaType};base64,${previewAtt.data}`} name={previewAtt.name} onClose={() => setPreviewId(null)} onRemove={() => setAtts((cur) => cur.filter((x) => x.id !== previewAtt.id))} />}
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
