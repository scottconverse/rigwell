// Pure TUI reducer: (state, event) -> {state, effects}. No I/O, no clock, no randomness (spec §13).
import { AUTONOMY_HELP, COMMANDS, KEY_HELP, findCommand, matchCommands } from "./commands.ts";
import { expandEntry, parseLoop } from "./customcmd.ts";
import { plainStyler, transcriptLines, transcriptOpts } from "./transcript.ts";
import { diffBody } from "./diff.ts";
import { managedLabel } from "../storage/org.ts";
import { formatContext, type ContextStats } from "./context.ts";
import { DEFAULT_DISPLAY, OTHER_LABEL, OTHER_VALUE, type DisplaySettings, type Effect, type Item, type Key, type Panel, type Step, type TuiEvent, type TuiState } from "./types.ts";

export interface InitOptions {
  version?: string; cwd: string; homeDir?: string; idPrefix?: string; agentsMd?: boolean;
  modelId?: string; autonomy?: TuiState["autonomy"]; mode?: TuiState["mode"]; reasoning?: string; theme?: "dark" | "light";
}

const AUTONOMY_ORDER: TuiState["autonomy"][] = ["off", "low", "medium", "high"];
const REASONING_ORDER = ["off", "low", "medium", "high"];
const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 });

export function initialState(o: InitOptions): TuiState {
  return {
    version: o.version ?? "0.1.0", cwd: o.cwd, homeDir: o.homeDir ?? "~/.rigwell", idPrefix: o.idPrefix ?? "tui", counter: 0,
    header: { agentsMd: o.agentsMd ?? false, skills: 0, mcps: 0, issues: 0 }, rows: 24, cols: 80, scroll: 0, custom: [],
    modelId: o.modelId ?? "", reasoning: o.reasoning ?? "high", autonomy: o.autonomy ?? "off", mode: o.mode ?? "auto", models: [],
    working: "idle", running: false, now: 0, contextUsed: 0, contextLimit: 0, tokenUsage: zeroUsage(), turns: 0,
    items: [], detailed: false, showThinking: false, input: { text: "", cursor: 0 }, history: [], historyIndex: null, draft: "",
    shellMode: false, vim: false, vimMode: "insert", theme: o.theme ?? "dark", autoCompress: true, menuIndex: 0, menuDismissed: false,
    atMenu: null, panels: [], sandbox: false, images: [], display: { ...DEFAULT_DISPLAY }, managed: [], todos: [], overlay: null, pending: { steer: [], queue: [] }, lastEscAt: -1e9, lastCtrlCAt: -1e9, quit: false,
  };
}

export const contextPercent = (s: TuiState): string | null => {
  if (!s.contextLimit) return null;
  const p = (s.contextUsed / s.contextLimit) * 100;
  return s.contextUsed > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

/** The slash menu is open while the first word after "/" is being typed. */
export function slashMenu(s: TuiState) {
  const t = s.input.text;
  if (!t.startsWith("/") || /[\s]/.test(t) || s.menuDismissed || s.panels.length || s.overlay) return [];
  return matchCommands(t.slice(1), s.custom);
}

const info = (text: string, level: "info" | "error" = "info"): Item => ({ kind: "info", text, level });

// ---------------------------------------------------------------- text editing

type Input = TuiState["input"];
const ins = (i: Input, t: string): Input => ({ text: i.text.slice(0, i.cursor) + t + i.text.slice(i.cursor), cursor: i.cursor + t.length });
const lineStart = (t: string, c: number) => t.lastIndexOf("\n", c - 1) + 1;
const lineEnd = (t: string, c: number) => { const e = t.indexOf("\n", c); return e < 0 ? t.length : e; };

function editKey(i: Input, k: Key, vimNormal = false): Input | null {
  const { text, cursor } = i;
  switch (k.name) {
    case "char": case "paste": return k.text ? ins(i, k.text) : i;
    case "backspace": return cursor ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 } : i;
    case "delete": return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "left": return { text, cursor: Math.max(0, cursor - 1) };
    case "right": return { text, cursor: Math.min(text.length, cursor + 1) };
    case "home": case "ctrl+a": return { text, cursor: lineStart(text, cursor) };
    case "end": case "ctrl+e": return { text, cursor: lineEnd(text, cursor) };
    case "ctrl+k": return { text: text.slice(0, cursor) + text.slice(lineEnd(text, cursor)), cursor };
    case "ctrl+u": { const s = lineStart(text, cursor); return { text: text.slice(0, s) + text.slice(cursor), cursor: s }; }
    case "ctrl+w": case "alt+backspace": {
      let c = cursor;
      while (c > 0 && /\s/.test(text[c - 1])) c--;
      while (c > 0 && !/\s/.test(text[c - 1])) c--;
      return { text: text.slice(0, c) + text.slice(cursor), cursor: c };
    }
    default: return vimNormal ? i : null;
  }
}

/** Vertical cursor move inside a multi-line input; null when already on the first/last line. */
function moveLine(i: Input, dir: -1 | 1): Input | null {
  const { text, cursor } = i;
  const s = lineStart(text, cursor);
  const col = cursor - s;
  if (dir < 0) {
    if (s === 0) return null;
    const ps = lineStart(text, s - 1);
    return { text, cursor: ps + Math.min(col, s - 1 - ps) };
  }
  const e = lineEnd(text, cursor);
  if (e >= text.length) return null;
  const ne = lineEnd(text, e + 1);
  return { text, cursor: e + 1 + Math.min(col, ne - e - 1) };
}

// ---------------------------------------------------------------- panels

function diffLines(oldC: string | undefined, newC: string | undefined, display: DisplaySettings = DEFAULT_DISPLAY, path = ""): string[] {
  return diffBody(oldC, newC, display.diffMode, path);
}

function describeUse(u: any, display: DisplaySettings): { group: string; line: string; detail: string[] } {
  const d = u.details ?? {};
  const t = u.confirmationType;
  if (t === "exec") return { group: "Commands", line: String(d.fullCommand ?? d.command ?? ""), detail: [] };
  if (t === "edit" || t === "apply_patch") return { group: "File Edits", line: String(d.filePath ?? d.fileName ?? u.toolUse?.name), detail: diffLines(d.oldContent, d.newContent, display, String(d.fileName ?? "")) };
  if (t === "create") return { group: "File Creations", line: String(d.filePath ?? d.fileName), detail: diffLines(undefined, d.content, display, String(d.fileName ?? "")) };
  return { group: "Other", line: `${t}: ${u.toolUse?.name ?? ""}`, detail: [] };
}

export function permissionPanel(id: string, params: any, display: DisplaySettings = DEFAULT_DISPLAY): Panel {
  const uses: any[] = params.toolUses ?? [];
  const opts: { label: string; value: string }[] = (params.options ?? []).map((o: any) => ({ label: String(o.label), value: String(o.value) }));
  const base = { id, action: { type: "request" as const, requestId: id, method: "request_permission" as const }, selected: 0, checked: [] as number[] };
  if (uses.length > 1) {
    const groups = new Map<string, string[]>();
    for (const u of uses) {
      const x = describeUse(u, display);
      groups.set(x.group, [...(groups.get(x.group) ?? []), "  " + x.line, ...x.detail.map((l) => "    " + l)]);
    }
    const body: string[] = [];
    for (const g of ["File Edits", "File Creations", "Commands", "Other"]) if (groups.has(g)) body.push(g, ...groups.get(g)!);
    const options = opts.map((o) => (o.value === "proceed_once" ? { ...o, label: "Yes, allow all" } : o.value === "cancel" ? { ...o, label: "No, cancel all" } : o));
    return { ...base, kind: "batch", title: `Approve ${uses.length} operations:`, body, options };
  }
  const u = uses[0] ?? {};
  const d = u.details ?? {};
  switch (u.confirmationType) {
    case "create_pr": return { ...base, kind: "permission", title: "Push branch and create PR?", body: [`Repository: ${d.repository}`, `Branch: ${d.branch}`, `Base: ${d.base}`, `Title: ${d.title}`, `Draft: ${d.draft ? "yes" : "no"}`, "", String(d.body)], options: opts };
    case "exec": {
      const body = [String(d.fullCommand ?? d.command ?? "")];
      if (d.impactLevel) body.push("", `${d.impactLevel} risk`);
      if (d.riskLevelReason) body.push("Why this needs approval:", String(d.riskLevelReason));
      const tag = d.listed === "allow" ? "(allowlisted)" : d.listed === "deny" ? "(denylisted)" : undefined;
      return { ...base, kind: "permission", title: "Command to approve", tag, body, options: opts };
    }
    case "edit": case "apply_patch": case "create": {
      const verb = u.confirmationType === "create" ? "Create" : u.confirmationType === "edit" ? "Edit" : "Patch";
      const body = u.confirmationType === "create" ? diffLines(undefined, d.content, display, String(d.fileName ?? "")) : diffLines(d.oldContent, d.newContent, display, String(d.fileName ?? ""));
      if (d.riskLevelReason) body.unshift(`Why this needs approval: ${d.riskLevelReason}`, "");
      return { ...base, kind: "permission", title: `${verb} ${d.fileName ?? d.filePath ?? ""}`.trim(), body, options: opts };
    }
    case "mcp_tool": {
      const body = [`Tool: ${d.toolName ?? u.toolUse?.name}`, `Impact: ${d.impactLevel ?? "unknown"}`];
      if (d.serverName) body.push(`Server: ${d.serverName}`);
      return { ...base, kind: "permission", title: "MCP tool to approve", body, options: opts };
    }
    case "exit_spec_mode": {
      const plan = String(d.plan ?? d.specContent ?? d.content ?? "");
      // Handoff options show how much of the context a new session saves (spec 5.5.7).
      const saved = typeof d.contextSavingsPercent === "number" ? ` (${d.contextSavingsPercent}% context saved)` : "";
      const options = opts.map((o) => (o.value.startsWith("proceed_new_session") ? { ...o, label: o.label + saved } : o));
      return { ...base, kind: "exit_spec", title: d.title ? `Specification for approval: ${d.title}` : "Specification for approval", body: plan.split("\n"), savePath: d.filePath ?? d.path, options };
    }
    case "secret_scan_violation": {
      // Secret-scan prompt (spec 13.4): the command, then what was found where. The secret itself is never shown.
      const found: any[] = Array.isArray(d.findings) ? d.findings : [];
      const body = [String(d.fullCommand ?? d.command ?? ""), "", `${d.count ?? found.length} possible secret${(d.count ?? found.length) === 1 ? "" : "s"} in the changes to commit:`,
        ...found.map((f) => `  ${f.description ?? f.rule}  ${f.file || "(unnamed)"}:${f.line}  ${f.preview ?? ""}`)];
      return { ...base, kind: "permission", title: String(d.title ?? "Possible secrets in the changes to commit"), body, options: opts };
    }
    case "script": {
      const body = (d.calls ?? []).map((c: any) => `line ${c.line}: ${c.toolName} ${JSON.stringify(c.toolInput ?? {})}`);
      return { ...base, kind: "permission", title: "Script to approve", body: body.length ? body : ["(no calls listed)"], options: opts };
    }
    default: {
      const body = [`${u.toolUse?.name ?? u.confirmationType ?? "tool"}`, JSON.stringify(u.toolUse?.input ?? d, null, 2)];
      return { ...base, kind: "permission", title: `Approve ${u.confirmationType ?? "action"}`, body: body.join("\n").split("\n"), options: opts };
    }
  }
}

function askPanel(id: string, p: any): Panel {
  const questions = (p.questions ?? []).map((q: any) => ({ ...q, options: q.options?.length ? q.options : ["Yes", "No"] }));
  return mkQuestion({
    id, kind: "ask_user", action: { type: "request", requestId: id, method: "ask_user" }, title: "", body: [], options: [],
    selected: 0, checked: [], questions, qIndex: 0, answers: [],
  });
}

function mkQuestion(p: Panel): Panel {
  const q = p.questions![p.qIndex!];
  return {
    ...p, title: `${q.topic ? `[${q.topic}] ` : ""}${q.question}`, body: [`Question ${p.qIndex! + 1} of ${p.questions!.length}`],
    options: [...q.options.map((o: string) => ({ label: o, value: o })), { label: OTHER_LABEL, value: OTHER_VALUE }],
    multi: !!q.multiSelect, selected: 0, checked: [], other: undefined,
  };
}

/** rigwell.request_trust: trust the folder (the harness remembers a yes) or not. */
export function trustPanel(id: string, p: any): Panel {
  const unlocks: string[] = Array.isArray(p.unlocks) ? p.unlocks.map(String) : [];
  return {
    id, kind: "trust", action: { type: "request", requestId: id, method: "request_trust" }, title: "Do you trust this folder?",
    body: [String(p.cwd ?? ""), "", ...(unlocks.length ? ["Trusting it loads from the folder:", ...unlocks.map((u) => "  - " + u)] : []), "", "Untrusted, the agent still works but ignores these."],
    options: [{ label: "Yes, trust this folder", value: "trust" }, { label: "No, don't trust it", value: "no" }],
    selected: 1, checked: [],
  };
}

function pickPanel(id: string, p: any): Panel {
  const rows: { id: string; label: string; detail?: string }[] = p.rows ?? [];
  const pre = new Set<string>(p.preselectedIds ?? []);
  return {
    id, kind: "pick_options", action: { type: "request", requestId: id, method: "pick_options" }, title: String(p.title ?? "Pick"),
    body: p.hint ? [String(p.hint)] : [], options: rows.map((r) => ({ label: r.detail ? `${r.label}  (${r.detail})` : r.label, value: r.id })),
    selected: 0, multi: !!p.multi, checked: rows.flatMap((r, i) => (pre.has(r.id) ? [i] : [])), rows,
  };
}

const cancelResult = (panel: Panel): { method: string; result: unknown } | null => {
  if (panel.action.type !== "request") return null;
  const m = panel.action.method;
  if (m === "request_permission") {
    const comment = panel.comment?.trim();
    return { method: m, result: { selectedOption: "cancel", ...(comment ? { comment } : {}) } };
  }
  if (m === "ask_user") return { method: m, result: { cancelled: true, answers: [] } };
  if (m === "request_trust") return { method: m, result: { trust: false } };
  return { method: m, result: { cancelled: true, selectedIds: [] } };
};

function finishPanel(s: TuiState, panel: Panel, picked: number[]): Step {
  const rest = s.panels.filter((p) => p !== panel);
  const state: TuiState = { ...s, panels: rest };
  const a = panel.action;
  if (a.type === "confirm") return { state, effects: picked.length && panel.options[picked[0]].value === "yes" ? a.effects : [] };
  if (a.type === "model") return { state: { ...state, hint: `Model: ${panel.options[picked[0]]?.label}` }, effects: [{ type: "settings", patch: { modelId: panel.options[picked[0]].value } }] };
  if (a.type === "resume") return { state, effects: [{ type: "resume", sessionId: panel.options[picked[0]].value }] };
  if (a.type === "rewind_pick") {
    const id = panel.options[picked[0]].value;
    const text = panel.rows?.find((r) => r.id === id)?.detail ?? "";
    const mode: Panel = {
      id: "rewind-mode", kind: "select", action: { type: "rewind_mode", messageId: id, text }, title: "Rewind to this message",
      body: [text.split("\n")[0].slice(0, 100), "Later messages are removed from the session. The message text goes back to the input box."],
      options: [{ label: "Rewind conversation and restore files", value: "files" }, { label: "Rewind conversation only", value: "conv" }, { label: "Cancel", value: "cancel" }],
      selected: 0, checked: [],
    };
    return { state: { ...state, panels: [...state.panels, mode] }, effects: [] };
  }
  if (a.type === "rewind_mode") {
    const v = panel.options[picked[0]].value;
    if (v === "cancel") return { state, effects: [] };
    return { state, effects: [{ type: "rewind", messageId: a.messageId, restoreFiles: v === "files" }] };
  }
  const value = picked.map((i) => panel.options[i].value);
  if (a.method === "request_permission") {
    // The comment box (Tab) rides along with whatever option is chosen; Ctrl+G's edited plan goes with proceed_edit (spec 5.5.7, 13.4).
    if (panel.kind === "exit_spec" && value[0] === "proceed_edit" && panel.editedSpec === undefined) {
      // Nothing edited yet: open the plan in $EDITOR first; the panel stays until the edit comes back.
      return { state: s, effects: [{ type: "editor", text: panel.body.join("\n"), target: "spec" }] };
    }
    const comment = panel.comment?.trim();
    const edited = panel.kind === "exit_spec" && value[0] === "proceed_edit" ? panel.editedSpec : undefined;
    // This client starts the new session itself when a handoff is chosen (spec 3.1.8 clientStartsHandoffSession).
    const handoff = panel.kind === "exit_spec" && String(value[0]).startsWith("proceed_new_session");
    return { state, effects: [{ type: "answer", requestId: a.requestId, method: a.method, result: { selectedOption: value[0], ...(comment ? { comment } : {}), ...(edited !== undefined ? { editedSpecContent: edited } : {}), ...(handoff ? { clientStartsHandoffSession: true } : {}) } }] };
  }
  if (a.method === "request_trust") return { state, effects: [{ type: "answer", requestId: a.requestId, method: a.method, result: { trust: value[0] === "trust" } }] };
  if (a.method === "pick_options") return { state, effects: [{ type: "answer", requestId: a.requestId, method: a.method, result: { selectedIds: value } }] };
  // ask_user: collect this answer; move to the next question or finish
  const q = panel.questions![panel.qIndex!];
  const otherIdx = panel.options.findIndex((o) => o.value === OTHER_VALUE);
  const wantsOther = otherIdx >= 0 && picked.includes(otherIdx);
  const typed = panel.other?.text.trim() ?? "";
  if (wantsOther && !typed) {
    // "Other...": open the free-text box; Enter there sends the answer.
    return { state: { ...s, panels: s.panels.map((p) => (p === panel ? { ...panel, other: { typing: true, text: "" } } : p)) }, effects: [] };
  }
  const answerValues = [...picked.filter((i) => i !== otherIdx).map((i) => panel.options[i].value), ...(wantsOther ? [typed] : [])];
  const answers = [...(panel.answers ?? []), { index: q.index, question: q.question, answer: answerValues.join(", ") }];
  if (panel.qIndex! + 1 < panel.questions!.length) {
    const next = mkQuestion({ ...panel, qIndex: panel.qIndex! + 1, answers });
    return { state: { ...s, panels: s.panels.map((p) => (p === panel ? next : p)) }, effects: [] };
  }
  return { state, effects: [{ type: "answer", requestId: a.requestId, method: a.method, result: { answers } }] };
}

const setPanel = (s: TuiState, panel: Panel, patch: Partial<Panel>): TuiState => ({ ...s, panels: [{ ...panel, ...patch }, ...s.panels.slice(1)] });
const commentKinds = new Set(["permission", "batch", "exit_spec"]);

/** Typing into a text box owned by the panel (the comment box or the "Other..." box). */
function boxKey(text: string, k: Key): string | null {
  if ((k.name === "char" || k.name === "paste") && k.text) return text + k.text;
  if (k.name === "backspace") return text.slice(0, -1);
  if (k.name === "ctrl+u") return "";
  if (k.name === "ctrl+w" || k.name === "alt+backspace") return text.replace(/\s*\S*$/, "");
  return null;
}

function panelKey(s: TuiState, k: Key): Step {
  const panel = s.panels[0];
  const n = panel.options.length;
  // "Other..." free text: the keys go to the box; Enter sends, Esc goes back to the options.
  if (panel.other?.typing) {
    if (k.name === "esc") return { state: setPanel(s, panel, { other: undefined }), effects: [] };
    if (k.name === "enter") {
      if (!panel.other.text.trim()) return { state: s, effects: [] };
      const idx = panel.options.findIndex((o) => o.value === OTHER_VALUE);
      const s2 = setPanel(s, panel, { other: { typing: false, text: panel.other.text } });
      return finishPanel(s2, s2.panels[0], panel.multi ? [...new Set([...panel.checked, idx])] : [idx]);
    }
    const t = boxKey(panel.other.text, k);
    return t === null ? { state: s, effects: [] } : { state: setPanel(s, panel, { other: { typing: true, text: t } }), effects: [] };
  }
  // The comment box (permission, batch and spec panels).
  if (panel.commentMode) {
    if (k.name === "esc" || k.name === "tab") return { state: setPanel(s, panel, { commentMode: false }), effects: [] };
    if (k.name === "enter") return finishPanel(s, panel, [panel.selected]);
    if (k.name === "up" || k.name === "down") return { state: setPanel(s, panel, { selected: (panel.selected + (k.name === "up" ? -1 : 1) + n) % Math.max(1, n) }), effects: [] };
    const t = boxKey(panel.comment ?? "", k);
    return t === null ? { state: s, effects: [] } : { state: setPanel(s, panel, { comment: t }), effects: [] };
  }
  if (k.name === "tab" && commentKinds.has(panel.kind)) return { state: setPanel(s, panel, { commentMode: true }), effects: [] };
  if (k.name === "ctrl+g" && panel.kind === "exit_spec") return { state: s, effects: [{ type: "editor", text: panel.editedSpec ?? panel.body.join("\n"), target: "spec" }] };
  const setSel = (sel: number): Step => ({ state: { ...s, panels: [{ ...panel, selected: (sel + n) % Math.max(1, n) }, ...s.panels.slice(1)] }, effects: [] });
  const toggle = (i: number): Step => ({
    state: { ...s, panels: [{ ...panel, checked: panel.checked.includes(i) ? panel.checked.filter((x) => x !== i) : [...panel.checked, i].sort((a, b) => a - b) }, ...s.panels.slice(1)] }, effects: [],
  });
  switch (k.name) {
    case "up": return setSel(panel.selected - 1);
    case "down": return setSel(panel.selected + 1);
    case "esc": {
      const c = cancelResult(panel);
      const rest = { ...s, panels: s.panels.slice(1) };
      if (!c) return { state: rest, effects: [] };
      const eff: Effect[] = [{ type: "answer", requestId: (panel.action as any).requestId, method: c.method, result: c.result }];
      if (panel.kind === "ask_user") eff.push({ type: "interrupt" }); // Esc on AskUser stops the agent (spec §13.4)
      return { state: rest, effects: eff };
    }
    case "enter":
      if (panel.multi) return finishPanel(s, panel, panel.checked);
      return n ? finishPanel(s, panel, [panel.selected]) : { state: s, effects: [] };
    case "char": {
      if (k.text === " " && panel.multi) return toggle(panel.selected);
      const d = k.text && /^[1-9]$/.test(k.text) ? Number(k.text) - 1 : -1;
      if (d >= 0 && d < n) return panel.multi ? toggle(d) : finishPanel(s, panel, [d]);
      return { state: s, effects: [] };
    }
    default: return { state: s, effects: [] };
  }
}

// ---------------------------------------------------------------- transcript

function messagesToItems(messages: any[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const m of messages) {
    if (m.visibility === "llm_only") continue;
    for (const b of m.content ?? []) {
      if (m.role === "user" && b.type === "text") items.push({ kind: "user", text: b.text, id: m.id });
      else if (m.role === "assistant" && b.type === "text") items.push({ kind: "assistant", id: `${m.id}:${items.length}`, text: b.text });
      else if (b.type === "tool_use") { const t = { kind: "tool" as const, id: b.id, name: b.name, input: b.input ?? {}, status: "ok" as const }; tools.set(b.id, t); items.push(t); }
      else if (b.type === "tool_result") {
        const t = tools.get(b.tool_use_id);
        if (t) { t.output = typeof b.content === "string" ? b.content : JSON.stringify(b.content); if (b.is_error) t.status = "error"; }
      }
    }
  }
  return items;
}

const resultText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("") : JSON.stringify(c ?? "");

function upsertTool(items: Item[], id: string, patch: Partial<Extract<Item, { kind: "tool" }>> & { name?: string }): Item[] {
  const i = items.findIndex((x) => x.kind === "tool" && x.id === id);
  if (i < 0) return [...items, { kind: "tool", id, name: patch.name ?? "tool", input: {}, status: "running", ...patch } as Item];
  const out = items.slice();
  out[i] = { ...(items[i] as any), ...patch };
  return out;
}

function notification(s: TuiState, n: { type: string; [k: string]: any }): Step {
  switch (n.type) {
    case "settings_updated": {
      const st = n.settings ?? {};
      return { state: { ...s, modelId: st.modelId ?? s.modelId, reasoning: st.reasoningEffort ?? s.reasoning, mode: st.interactionMode ?? s.mode, autonomy: st.autonomyLevel ?? s.autonomy, sandbox: st.sandbox ? st.sandbox.active === true : s.sandbox }, effects: [] };
    }
    case "agent_working_state_changed":
      return { state: { ...s, working: n.newState, running: n.newState !== "idle" ? true : s.running }, effects: [] };
    case "assistant_text_delta": {
      const id = `${n.messageId}:${n.blockIndex}`;
      const last = s.items.at(-1);
      if (last?.kind === "assistant" && last.id === id) return { state: { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + n.textDelta }] }, effects: [] };
      return { state: { ...s, items: [...s.items, { kind: "assistant", id, text: n.textDelta }] }, effects: [] };
    }
    case "thinking_text_delta": {
      const id = `${n.messageId}:${n.blockIndex}`;
      const last = s.items.at(-1);
      if (last?.kind === "thinking" && last.id === id) return { state: { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + n.textDelta }] }, effects: [] };
      return { state: { ...s, items: [...s.items, { kind: "thinking", id, text: n.textDelta }] }, effects: [] };
    }
    case "tool_call": // sent repeatedly while input streams: replace by id, never append (spec §3.1.7)
      return { state: { ...s, items: upsertTool(s.items, n.toolUse.id, { name: n.toolUse.name, input: n.toolUse.input ?? {} }) }, effects: [] };
    case "tool_execution_phase_changed":
      return { state: { ...s, items: upsertTool(s.items, n.toolUseId, { name: n.toolName, phase: n.phase }) }, effects: [] };
    case "tool_progress_update": {
      const u = n.update ?? {};
      const live = typeof u.fullOutput === "string" ? u.fullOutput : typeof u.text === "string" ? u.text : undefined;
      return { state: live === undefined ? s : { ...s, items: upsertTool(s.items, n.toolUseId, { name: n.toolName, live }) }, effects: [] };
    }
    case "tool_result": {
      // Steering messages are delivered by the harness after the next tool call (queuePlacement end_of_loop): show them now.
      const items = upsertTool(s.items, n.toolUseId, { status: n.isError ? "error" : "ok", output: resultText(n.content) });
      const steer = s.pending.steer;
      return { state: { ...s, items: steer.length ? [...items, ...steer.map((text): Item => ({ kind: "user", text }))] : items, pending: steer.length ? { ...s.pending, steer: [] } : s.pending }, effects: [] };
    }
    case "session_token_usage_changed": {
      const l = n.lastCallTokenUsage;
      return { state: { ...s, tokenUsage: { ...s.tokenUsage, ...(n.tokenUsage ?? {}) }, contextUsed: l ? (l.inputTokens ?? 0) + (l.cacheReadTokens ?? 0) : s.contextUsed }, effects: [] };
    }
    case "todo_state_changed": {
      const todos = (Array.isArray(n.todos) ? n.todos : []).filter((t: any) => t && typeof t.content === "string").map((t: any) => ({ id: t.id, content: t.content, status: t.status }));
      if (s.display.todoDisplayMode !== "inline") return { state: { ...s, todos }, effects: [] };
      // inline: the list appears in the transcript; a list that follows another one replaces it
      const last = s.items.at(-1);
      const items = last?.kind === "todos" ? s.items.slice(0, -1) : s.items;
      return { state: { ...s, todos, items: todos.length ? [...items, { kind: "todos", todos }] : items }, effects: [] };
    }
    case "daemon.side_chat_entry": {
      const e = n.entry ?? {};
      if (typeof e.id !== "string") return { state: s, effects: [] };
      const item: Item = { kind: "btw", id: e.id, question: String(e.question ?? ""), answer: String(e.answer ?? ""), status: e.status ?? "pending" };
      const at = s.items.findIndex((x) => x.kind === "btw" && x.id === e.id);
      return { state: { ...s, items: at < 0 ? [...s.items, item] : s.items.map((x, k) => (k === at ? item : x)) }, effects: [] };
    }
    case "spec_handoff":
      return { state: { ...s, handoff: { specHandoffId: String(n.specHandoffId) }, items: [...s.items, info(`Plan approved. Continuing in a new session${typeof n.contextSavingsPercent === "number" ? ` (${n.contextSavingsPercent}% less context)` : ""}.`)] }, effects: [] };
    case "permission_resolved":
      return { state: { ...s, panels: s.panels.filter((p) => p.action.type !== "request" || p.action.requestId !== n.requestId) }, effects: [] };
    case "llm_retry":
      return { state: { ...s, items: [...s.items, info(`Model call failed (${n.reason}); retry ${n.attempt}`)] }, effects: [] };
    case "session_compacted":
      return { state: { ...s, items: [...s.items, info(`Conversation compacted (${n.removedCount} messages removed)`)] }, effects: [] };
    case "error":
      return { state: { ...s, items: [...s.items, info(String(n.message ?? "error"), "error")] }, effects: [] };
    case "agent_turn_completed": {
      // Requests still on screen belong to the finished turn: the harness settled them as cancelled.
      const dead = s.panels.filter((p) => p.action.type === "request");
      const effects: Effect[] = dead.map((p) => ({ type: "answer", requestId: (p.action as any).requestId, method: (p.action as any).method, result: cancelResult(p)!.result }));
      // Steering messages the harness did not deliver mid-turn run as the next turn on its side: show them in the transcript.
      const flushed: Item[] = n.reason === "cancelled" ? [] : s.pending.steer.map((text): Item => ({ kind: "user", text }));
      let state: TuiState = {
        ...s, running: false, working: "idle", runStartedAt: undefined, turns: s.turns + 1, panels: s.panels.filter((p) => p.action.type !== "request"),
        items: [...s.items, ...flushed, ...(n.reason === "completed" || n.reason === "spec_handoff" ? [] : [info(`Turn ended: ${n.reason}`, n.reason === "cancelled" ? "info" : "error")])],
        pending: n.reason === "cancelled" ? s.pending : { ...s.pending, steer: [] },
      };
      if (flushed.length) state = { ...state, running: true, working: "thinking", runStartedAt: s.now };
      effects.push({ type: "fetch_context", show: false }, { type: "status_line" });
      if (n.reason === "completed") effects.push({ type: "attention", kind: "completion" });
      // An approved spec handoff: the old session is done; open the new one with the spec as its brief.
      if (n.reason === "spec_handoff" && s.handoff) {
        effects.push({ type: "handoff", specHandoffId: s.handoff.specHandoffId });
        state = { ...state, handoff: undefined };
      }
      // Queued messages (Ctrl+Enter) go out when the agent has finished.
      if (n.reason !== "cancelled" && !flushed.length) {
        const next = state.pending.queue[0];
        if (next !== undefined) {
          const sent = startTurn({ ...state, pending: { ...state.pending, queue: state.pending.queue.slice(1) } }, next);
          state = sent.state;
          effects.push(...sent.effects);
        }
      } else if (state.pending.steer.length + state.pending.queue.length) {
        state = { ...state, hint: "Interrupted: pending messages kept (Ctrl+R review, Ctrl+G pull, Ctrl+X clear)" };
      }
      return { state, effects };
    }
    default: return { state: s, effects: [] };
  }
}

/** Starts a turn. `display` is what the transcript shows when it differs from the text sent (custom commands, skills). */
function startTurn(s: TuiState, text: string, display?: string): Step {
  const id = `${s.idPrefix}-${s.counter + 1}`;
  const images = s.images.length ? { images: s.images } : {};
  const shown = s.images.length ? `${display ?? text}\n${s.images.map((_, i) => `[Image #${i + 1}]`).join(" ")}` : display ?? text;
  return {
    state: { ...s, counter: s.counter + 1, running: true, runStartedAt: s.now, working: "thinking", scroll: 0, images: [], items: [...s.items, { kind: "user", text: shown, id }] },
    effects: [{ type: "send", text, messageId: id, ...images }],
  };
}

// ---------------------------------------------------------------- slash commands

const later = (what: string, phase: string) => [`${what} is not available in this build yet.`, `It comes with ${phase}.`];

/** Picker over the user messages of this session (spec §13.2 /rewind-conversation, double Esc on empty input). */
export function rewindMenu(s: TuiState): Step {
  const users = s.items.filter((i): i is Extract<Item, { kind: "user" }> => i.kind === "user" && !!i.id && !i.text.startsWith("! "));
  if (!users.length) return { state: { ...s, items: [...s.items, info("No earlier messages to go back to.", "error")] }, effects: [] };
  const rows = users.map((u) => ({ id: u.id!, label: u.text.split("\n")[0].slice(0, 80), detail: u.text }));
  const panel: Panel = {
    id: "rewind", kind: "select", action: { type: "rewind_pick" }, title: "Rewind to an earlier message", body: ["Pick the message to go back to (newest last)."],
    options: rows.map((r) => ({ label: r.label || "(empty)", value: r.id })), rows, selected: rows.length - 1, checked: [],
  };
  return { state: { ...s, panels: [...s.panels, panel] }, effects: [] };
}

function overlay(s: TuiState, title: string, lines: string[]): Step {
  return { state: { ...s, overlay: { title, lines }, input: { text: "", cursor: 0 } }, effects: [] };
}

function modelName(s: TuiState) { return s.models.find((m) => m.id === s.modelId)?.displayName ?? s.modelId; }

function runCommand(s0: TuiState, line: string): Step {
  const [head, ...restWords] = line.slice(1).trim().split(/\s+/);
  const args = restWords.join(" ");
  const cmd = findCommand(head);
  const s: TuiState = { ...s0, input: { text: "", cursor: 0 }, historyIndex: null, menuDismissed: false };
  if (!cmd) {
    const entry = s.custom.find((e) => e.name === head.toLowerCase());
    if (entry) return sendText({ ...s, items: s.items }, expandEntry(entry, args), `/${entry.name}${args ? " " + args : ""}`, false);
    return { state: { ...s, items: [...s.items, info(`Unknown command: /${head}. Type /help.`, "error")] }, effects: [] };
  }
  const view = (name: Extract<Effect, { type: "view" }>["name"]): Step => ({ state: s, effects: [{ type: "view", name, args }] });
  const guard = (effects: Effect[], what: string): Step => {
    if (!s.running) return { state: s, effects };
    const panel: Panel = {
      id: `confirm-${s.counter}`, kind: "confirm", action: { type: "confirm", effects: [{ type: "interrupt" }, ...effects] },
      title: "Stop the current run?", body: [`/${cmd.name} ${what}`, "The running turn will be cancelled and any unsent pending messages are lost."],
      options: [{ label: "Yes, stop and continue", value: "yes" }, { label: "No, keep running", value: "no" }], selected: 1, checked: [],
    };
    return { state: { ...s, panels: [...s.panels, panel] }, effects: [] };
  };
  switch (cmd.name) {
    case "help": return overlay(s, "Help", [
      "Keys", ...KEY_HELP.map(([k, d]) => `  ${k.padEnd(26)} ${d}`), "", "Autonomy levels (Ctrl+L)", ...AUTONOMY_HELP.map(([k, d]) => `  ${k.padEnd(8)} ${d}`),
      "", "Modes: auto, spec (Shift+Tab). In spec mode the agent researches and plans first.", "", "Commands", ...COMMANDS.map((c) => `  /${c.name}${c.args ? " " + c.args : ""}`.padEnd(30) + c.desc),
    ]);
    case "new": return guard([{ type: "new_session" }], "starts a new session");
    case "sessions":
      if (args) return guard([{ type: "resume", sessionId: args }], `resumes ${args}`);
      return { state: s, effects: [{ type: "list_sessions" }] };
    case "model": {
      if (!s.models.length) return { state: { ...s, items: [...s.items, info("No models are configured.", "error")] }, effects: [] };
      const panel: Panel = {
        id: "model", kind: "select", action: { type: "model" }, title: "Select a model", body: [],
        options: s.models.map((m) => ({ label: `${m.displayName ?? m.id}${m.id === s.modelId ? " (current)" : ""}`, value: m.id })),
        selected: Math.max(0, s.models.findIndex((m) => m.id === s.modelId)), checked: [],
      };
      return { state: { ...s, panels: [...s.panels, panel] }, effects: [] };
    }
    case "settings": {
      const lab = (key: string) => { const m = managedLabel(s.managed, key); return m ? "  " + m : ""; };
      const d = s.display;
      return overlay(s, "Settings", [
        `Model:            ${modelName(s)} (${s.modelId})${lab("sessionDefaultSettings")}`, `Reasoning:        ${s.reasoning}  (Tab cycles)`, `Autonomy:         ${s.autonomy}  (Ctrl+L cycles)${s.maxAutonomy ? `  max ${s.maxAutonomy}` : ""}${lab("maxAutonomyLevel")}`,
        `Interaction mode: ${s.mode}  (Shift+Tab toggles)`, `Auto-compress:    ${s.autoCompress ? "on" : "off"}  (Alt+X toggles)`, `Vim keys:         ${s.vim ? "on" : "off"}  (/vim)`,
        `Theme:            ${s.theme}  (/themes)`, `Show thinking:    ${s.showThinking ? "on" : "off"}${lab("showThinkingInMainView")}`, "",
        "Display", `  diffMode:                 ${d.diffMode}${lab("diffMode")}`, `  todoDisplayMode:          ${d.todoDisplayMode}${lab("todoDisplayMode")}`,
        `  toolResultDisplay:        ${d.toolResultDisplay}${lab("toolResultDisplay")}`, `  outputStyle:              ${d.outputStyle}${lab("outputStyle")}`,
        `  streamAssistantResponses: ${d.streamAssistantResponses ? "on" : "off"}${lab("streamAssistantResponses")}`,
        ...(s.managed.length ? ["", `Set by your organization ${managedLabel(s.managed, s.managed[0]!)}: ${s.managed.join(", ")}`] : []),
        "", "Settings files: ~/.rigwell/settings.json and <project>/.rigwell/settings.json",
      ]);
    }
    case "context": return { state: s, effects: [{ type: "fetch_context", show: true }] };
    case "cost": {
      const u = s.tokenUsage;
      return overlay(s, "Cost", [
        `Input tokens:          ${u.inputTokens}`, `Output tokens:         ${u.outputTokens}`, `Cache read tokens:     ${u.cacheReadTokens}`,
        `Cache creation tokens: ${u.cacheCreationTokens}`, `Thinking tokens:       ${u.thinkingTokens}`, `Turns:                 ${s.turns}`,
        "", "No pricing data is configured for local models, so no money amount is shown.",
      ]);
    }
    case "status": return overlay(s, "Status", [
      `Version:     ${s.version}`, `Mode:        ${s.mode} / autonomy ${s.autonomy}`, `Session:     ${s.sessionId ?? "(none)"}`, `Folder:      ${s.cwd}`,
      `Model:       ${modelName(s)}`, "Auth:        local (no account)", `Data folder: ${s.homeDir}`,
    ]);
    case "compress": return guard([{ type: "rpc", method: "compact_session", params: args ? { customInstructions: args } : {}, label: "compress", after: "resume_new" }], "summarises into a new session");
    case "rewind-conversation": return s.running ? guard([{ type: "open_rewind" }], "goes back to an earlier message") : rewindMenu(s);
    case "fork": return { state: s, effects: [{ type: "rpc", method: "fork_session", params: {}, label: "fork", after: "resume_new" }] };
    case "rename":
      if (!args) return { state: { ...s, items: [...s.items, info("Usage: /rename <title>", "error")] }, effects: [] };
      return { state: s, effects: [{ type: "rpc", method: "rename_session", params: { title: args }, label: "rename" }] };
    case "btw":
      if (!args) return { state: { ...s, items: [...s.items, info("Usage: /btw <question>", "error")] }, effects: [] };
      return { state: s, effects: [{ type: "btw", question: args }] };
    case "copy": {
      const last = [...s.items].reverse().find((i) => i.kind === "assistant") as Extract<Item, { kind: "assistant" }> | undefined;
      if (!last) return { state: { ...s, items: [...s.items, info("No assistant message to copy yet.", "error")] }, effects: [] };
      return { state: { ...s, hint: "Copied the last assistant message" }, effects: [{ type: "copy", text: last.text }] };
    }
    case "cwd":
      if (!args) return { state: { ...s, items: [...s.items, info(`Folder: ${s.cwd}. Usage: /cwd <dir>`)] }, effects: [] };
      return guard([{ type: "new_session", cwd: args }], `moves to ${args} in a new session`);
    case "pr": case "mcp": case "hooks": case "skills": case "commands": case "agents": case "diagnostics": case "statusline": case "automations": case "loop": case "login": case "logout":
      return view(cmd.name as any);
    case "vim": return { state: { ...s, vim: !s.vim, vimMode: "insert", hint: `Vim keys ${s.vim ? "off" : "on"}` }, effects: [] };
    case "themes": {
      const t = args === "light" || args === "dark" ? args : s.theme === "dark" ? "light" : "dark";
      return { state: { ...s, theme: t, hint: `Theme: ${t}` }, effects: [] };
    }
    case "quit": return { state: { ...s, quit: true }, effects: [{ type: "quit" }] };
  }
  return { state: s, effects: [] };
}

// ---------------------------------------------------------------- transcript scrolling (spec §13.3)

const viewHeight = (s: TuiState) => Math.max(3, s.rows - 9);
const pageSize = (s: TuiState) => Math.max(1, viewHeight(s) - 1);
function scrollBy(s: TuiState, delta: number): Step {
  return { state: { ...s, scroll: Math.max(0, s.scroll + delta) }, effects: [] };
}
/** Scroll so that the previous (dir -1) or next (dir 1) user message is at the top of the viewport. */
function scrollTurn(s: TuiState, dir: -1 | 1): Step {
  const header = 7;
  const { lines, userStarts } = transcriptLines(s.items, transcriptOpts(s), plainStyler());
  const total = header + lines.length, vh = viewHeight(s);
  const top = Math.max(0, total - s.scroll - vh);
  const starts = userStarts.map((u) => u + header);
  const target = dir < 0 ? [...starts].reverse().find((u) => u < top) : starts.find((u) => u > top);
  if (target === undefined) return { state: { ...s, scroll: dir < 0 ? Math.max(0, total - vh) : 0 }, effects: [] };
  return { state: { ...s, scroll: Math.max(0, total - (target + vh)) }, effects: [] };
}

// ---------------------------------------------------------------- submit and keys

function remember(s: TuiState, text: string): TuiState {
  return { ...s, history: s.history.at(-1) === text ? s.history : [...s.history, text], historyIndex: null, draft: "" };
}

function submit(s0: TuiState, queueOnly: boolean): Step {
  const raw = s0.input.text;
  const text = raw.trim();
  if (!text) return { state: s0, effects: [] };
  const cleared: TuiState = { ...remember(s0, raw), input: { text: "", cursor: 0 }, menuDismissed: false, atMenu: null, hint: undefined };
  if (s0.shellMode) return { state: { ...cleared, shellMode: false, items: [...cleared.items, { kind: "user", text: "! " + text }] }, effects: [{ type: "shell", command: text }] };
  if (text.startsWith("/")) return runCommand(cleared, text);
  return sendText(cleared, text, undefined, queueOnly);
}

/**
 * Sends a user message. While a turn runs, Enter steers: the message goes to the harness at once with
 * queuePlacement end_of_loop (delivered after the next tool call) and is listed under "Steering messages" until then.
 * Ctrl+Enter queues on the client and sends when the agent has finished.
 */
function sendText(s: TuiState, text: string, display: string | undefined, queueOnly: boolean): Step {
  if (!s.running) return startTurn(s, text, display);
  if (queueOnly) return { state: { ...s, pending: { ...s.pending, queue: [...s.pending.queue, text] } }, effects: [] };
  const id = `${s.idPrefix}-${s.counter + 1}`;
  return {
    state: { ...s, counter: s.counter + 1, images: [], pending: { ...s.pending, steer: [...s.pending.steer, display ?? text] } },
    effects: [{ type: "send", text, messageId: id, queuePlacement: "end_of_loop", ...(s.images.length ? { images: s.images } : {}) }],
  };
}

function cycle<T>(list: T[], cur: T): T { return list[(Math.max(0, list.indexOf(cur)) + 1) % list.length]; }

function afterEdit(s: TuiState, prevText: string): Step {
  let state = s;
  if (s.input.text !== prevText) state = { ...state, menuDismissed: false, menuIndex: 0, historyIndex: s.historyIndex };
  const before = s.input.text.slice(0, s.input.cursor);
  const m = /(?:^|\s)@([^\s]*)$/.exec(before);
  if (m && !s.shellMode && state.input.text !== prevText) return { state, effects: [{ type: "files", query: m[1] }] };
  if (!m && state.atMenu) state = { ...state, atMenu: null };
  return { state, effects: [] };
}

function pickAt(s: TuiState): Step {
  const a = s.atMenu!;
  const choice = a.items[a.selected];
  const before = s.input.text.slice(0, s.input.cursor);
  const m = /(^|\s)@([^\s]*)$/.exec(before)!;
  const start = before.length - m[2].length - 1;
  const isDir = choice.endsWith("/");
  const ins = "@" + choice + (isDir ? "" : " ");
  const text = s.input.text.slice(0, start) + ins + s.input.text.slice(s.input.cursor);
  const cursor = start + ins.length;
  const state: TuiState = { ...s, input: { text, cursor }, atMenu: null };
  return { state, effects: isDir ? [{ type: "files", query: choice }] : [] };
}

function inputKey(s: TuiState, k: Key, now: number): Step {
  const prev = s.input.text;
  const slash = slashMenu(s);

  // vim normal mode (minimal: i a h l 0 $ x)
  if (s.vim && s.vimMode === "normal") {
    const t = k.name === "char" ? k.text : undefined;
    const set = (input: Input, vimMode: "insert" | "normal" = "normal"): Step => ({ state: { ...s, input, vimMode }, effects: [] });
    if (t === "i") return set(s.input, "insert");
    if (t === "a") return set({ ...s.input, cursor: Math.min(s.input.text.length, s.input.cursor + 1) }, "insert");
    if (t === "h") return set({ ...s.input, cursor: Math.max(0, s.input.cursor - 1) });
    if (t === "l") return set({ ...s.input, cursor: Math.min(s.input.text.length, s.input.cursor + 1) });
    if (t === "0") return set({ ...s.input, cursor: lineStart(s.input.text, s.input.cursor) });
    if (t === "$") return set({ ...s.input, cursor: lineEnd(s.input.text, s.input.cursor) });
    if (t === "x") return set(editKey(s.input, { name: "delete" })!);
    if (k.name !== "enter") return { state: s, effects: [] };
  }

  switch (k.name) {
    case "enter": case "ctrl+enter": case "alt+enter": {
      const queueOnly = k.name !== "enter";
      if (k.name === "enter" && s.atMenu?.items.length) return pickAt(s);
      if (k.name === "enter" && slash.length) {
        const sel = slash[Math.min(s.menuIndex, slash.length - 1)];
        const typed = s.input.text.slice(1).toLowerCase();
        if (typed !== sel.name && !sel.aliases?.includes(typed)) {
          const text = `/${sel.name} `;
          return { state: { ...s, input: { text, cursor: text.length }, menuIndex: 0 }, effects: [] };
        }
      }
      if (k.name === "enter" && s.input.text[s.input.cursor - 1] === "\\") {
        const c = s.input.cursor;
        return { state: { ...s, input: { text: s.input.text.slice(0, c - 1) + "\n" + s.input.text.slice(c), cursor: c } }, effects: [] };
      }
      return submit(s, queueOnly);
    }
    case "tab": {
      if (s.atMenu?.items.length) return pickAt(s);
      if (slash.length) {
        const text = `/${slash[Math.min(s.menuIndex, slash.length - 1)].name} `;
        return { state: { ...s, input: { text, cursor: text.length }, menuIndex: 0 }, effects: [] };
      }
      const reasoning = cycle(REASONING_ORDER, s.reasoning);
      return { state: { ...s, reasoning }, effects: [{ type: "settings", patch: { reasoningEffort: reasoning } }] };
    }
    case "up": case "down": {
      const dir = k.name === "up" ? -1 : 1;
      if (s.atMenu?.items.length) { const n = s.atMenu.items.length; return { state: { ...s, atMenu: { ...s.atMenu, selected: (s.atMenu.selected + dir + n) % n } }, effects: [] }; }
      if (slash.length) return { state: { ...s, menuIndex: (Math.min(s.menuIndex, slash.length - 1) + dir + slash.length) % slash.length }, effects: [] };
      const moved = moveLine(s.input, dir);
      if (moved) return { state: { ...s, input: moved }, effects: [] };
      if (dir < 0 && s.history.length) {
        const idx = s.historyIndex === null ? s.history.length - 1 : Math.max(0, s.historyIndex - 1);
        const text = s.history[idx];
        return { state: { ...s, historyIndex: idx, draft: s.historyIndex === null ? s.input.text : s.draft, input: { text, cursor: text.length } }, effects: [] };
      }
      if (dir > 0 && s.historyIndex !== null) {
        const idx = s.historyIndex + 1;
        const text = idx >= s.history.length ? s.draft : s.history[idx];
        return { state: { ...s, historyIndex: idx >= s.history.length ? null : idx, input: { text, cursor: text.length } }, effects: [] };
      }
      return { state: s, effects: [] };
    }
    case "backspace":
      if (!s.input.text && s.shellMode) return { state: { ...s, shellMode: false }, effects: [] };
      break;
    case "char":
      if (k.text === "!" && !s.input.text && !s.shellMode) return { state: { ...s, shellMode: true }, effects: [] };
      if (k.text === "?" && !s.input.text) return runCommand(s, "/help");
      break;
    case "esc": {
      if (s.vim && s.vimMode === "insert") return { state: { ...s, vimMode: "normal", input: { ...s.input, cursor: Math.max(0, s.input.cursor - 1) } }, effects: [] };
      break;
    }
  }
  const edited = editKey(s.input, k);
  if (!edited) return { state: s, effects: [] };
  return afterEdit({ ...s, input: edited, historyIndex: edited.text === prev ? s.historyIndex : null }, prev);
}

function escape(s: TuiState, now: number): Step {
  if (s.overlay) return { state: { ...s, overlay: null }, effects: [] };
  if (s.panels.length) return panelKey(s, { name: "esc" });
  if (s.atMenu) return { state: { ...s, atMenu: null }, effects: [] };
  if (slashMenu(s).length) return { state: { ...s, menuDismissed: true }, effects: [] };
  if (s.shellMode) return { state: { ...s, shellMode: false }, effects: [] };
  if (s.vim && s.vimMode === "insert") return inputKey(s, { name: "esc" }, now);
  if (s.running) return { state: { ...s, hint: "Interrupting...", lastEscAt: now }, effects: [{ type: "interrupt" }] };
  if (now - s.lastEscAt < 600) {
    if (s.input.text) return { state: { ...s, input: { text: "", cursor: 0 }, lastEscAt: -1e9, historyIndex: null }, effects: [] };
    return rewindMenu({ ...s, lastEscAt: -1e9 });
  }
  return { state: { ...s, lastEscAt: now }, effects: [] };
}

function key(s: TuiState, k: Key, now: number): Step {
  if (k.name === "ctrl+o") return { state: { ...s, detailed: !s.detailed }, effects: [] };
  if (s.overlay) {
    if (k.name === "esc" || k.name === "enter" || (k.name === "char" && (k.text === "q" || k.text === "?"))) return { state: { ...s, overlay: null }, effects: [] };
    return { state: s, effects: [] };
  }
  if (k.name === "ctrl+c") {
    if (s.panels.length) return panelKey(s, { name: "esc" });
    if (s.input.text || s.shellMode) return { state: { ...s, input: { text: "", cursor: 0 }, shellMode: false, lastCtrlCAt: now, historyIndex: null }, effects: [] };
    if (now - s.lastCtrlCAt < 1500) return { state: { ...s, quit: true }, effects: [{ type: "quit" }] };
    return { state: { ...s, lastCtrlCAt: now, hint: "Press Ctrl+C again to quit" }, effects: [] };
  }
  if (k.name === "ctrl+d" && !s.input.text) return { state: { ...s, quit: true }, effects: [{ type: "quit" }] };
  if (s.panels.length) return panelKey(s, k);
  switch (k.name) {
    case "pageup": case "alt+pageup": return scrollBy(s, pageSize(s));
    case "pagedown": case "alt+pagedown": return scrollBy(s, -pageSize(s));
    case "alt+up": case "alt+down": return scrollTurn(s, k.name === "alt+up" ? -1 : 1);
    case "esc": return escape(s, now);
    case "shift+tab": {
      const mode = s.mode === "auto" ? "spec" : "auto";
      return { state: { ...s, mode }, effects: [{ type: "settings", patch: { interactionMode: mode } }] };
    }
    case "ctrl+l": {
      // An org ceiling skips the levels above it (they would be refused anyway).
      const allowed = AUTONOMY_ORDER.filter((l) => !s.maxAutonomy || AUTONOMY_ORDER.indexOf(l) <= AUTONOMY_ORDER.indexOf(s.maxAutonomy));
      const autonomy = cycle(allowed, allowed.includes(s.autonomy) ? s.autonomy : allowed[allowed.length - 1]!);
      const capped = s.maxAutonomy && autonomy !== cycle(AUTONOMY_ORDER, s.autonomy) ? `Autonomy is capped at ${s.maxAutonomy} ${managedLabel(s.managed, "maxAutonomyLevel")}`.trim() : s.hint;
      return { state: { ...s, autonomy, hint: capped }, effects: [{ type: "settings", patch: { autonomyLevel: autonomy } }] };
    }
    case "ctrl+n": {
      if (!s.models.length) return { state: s, effects: [] };
      const next = s.models[(Math.max(0, s.models.findIndex((m) => m.id === s.modelId)) + 1) % s.models.length];
      return { state: { ...s, modelId: next.id }, effects: [{ type: "settings", patch: { modelId: next.id } }] };
    }
    case "alt+x": return { state: { ...s, autoCompress: !s.autoCompress }, effects: [{ type: "settings", patch: { compactionThresholdCheckEnabled: !s.autoCompress } }] };
    case "ctrl+p": return { state: s, effects: [{ type: "editor", text: s.input.text }] };
    case "ctrl+v": return { state: s, effects: [{ type: "paste_image" }] };
    case "ctrl+shift+c":
      return s.input.text ? { state: { ...s, hint: "Copied the input" }, effects: [{ type: "copy", text: s.input.text }] } : { state: { ...s, hint: "The input is empty" }, effects: [] };
    case "ctrl+r": {
      const all = [...s.pending.steer.map((t) => `steer (sent, delivered after the next tool call):  ${t}`), ...s.pending.queue.map((t) => `queued (sent when the agent finishes):  ${t}`)];
      return overlay(s, "Pending messages", all.length ? all : ["Nothing is pending."]);
    }
    case "ctrl+g": {
      // Steering messages are already with the harness; only queued ones can be pulled back.
      const text = s.pending.queue[0];
      if (text === undefined) return { state: s, effects: [] };
      return { state: { ...s, pending: { ...s.pending, queue: s.pending.queue.slice(1) }, input: { text, cursor: text.length } }, effects: [] };
    }
    case "ctrl+x": return { state: { ...s, pending: { ...s.pending, queue: [] } }, effects: [] };
  }
  return inputKey(s, k, now);
}

// ---------------------------------------------------------------- the reducer

export function reduce(s: TuiState, e: TuiEvent): Step {
  switch (e.type) {
    case "key": return key({ ...s, now: e.now }, e.key, e.now);
    case "tick": return { state: { ...s, now: e.now }, effects: [] };
    case "notification": return notification({ ...s, now: e.now }, e.n);
    case "request": {
      const panel = e.method === "request_permission" ? permissionPanel(e.id, e.params, s.display) : e.method === "ask_user" ? askPanel(e.id, e.params)
        : e.method === "request_trust" ? trustPanel(e.id, e.params) : pickPanel(e.id, e.params);
      return { state: { ...s, panels: [...s.panels, panel], working: "waiting_for_tool_confirmation" }, effects: [{ type: "attention", kind: "awaiting" }] };
    }
    case "session_ready": {
      const r = e.result ?? {};
      const st = r.settings ?? {};
      const base: TuiState = {
        ...s, sessionId: r.sessionId, modelId: st.modelId ?? s.modelId, reasoning: st.reasoningEffort ?? s.reasoning,
        autonomy: st.autonomyLevel ?? s.autonomy, mode: st.interactionMode ?? s.mode, sandbox: st.sandbox?.active === true,
        models: (r.availableModels ?? s.models).map((m: any) => ({ id: m.id, displayName: m.displayName })),
      };
      if (!e.fresh) return { state: base, effects: [] };
      // A resumed session may still be waiting for answers (load_session pendingPermissions / pendingAskUserRequests): show them again.
      const reshown: Panel[] = [
        ...(r.pendingPermissions ?? []).filter((x: any) => typeof x?.requestId === "string").map((x: any) => permissionPanel(x.requestId, x)),
        ...(r.pendingAskUserRequests ?? []).filter((x: any) => typeof x?.requestId === "string").map((x: any) => askPanel(x.requestId, x)),
      ];
      const busy = r.isAgentLoopInProgress === true || reshown.length > 0;
      return {
        state: {
          ...base, items: messagesToItems(r.session?.messages ?? []), tokenUsage: r.tokenUsage ?? zeroUsage(), contextUsed: 0,
          running: busy, runStartedAt: busy ? s.now : undefined, working: reshown.length ? "waiting_for_tool_confirmation" : busy ? (r.workingState ?? "streaming_assistant_message") : "idle",
          pending: { steer: [], queue: [] }, panels: reshown, overlay: null, turns: 0, input: { text: "", cursor: 0 }, atMenu: null, scroll: 0,
        },
        effects: [{ type: "fetch_context", show: false }, { type: "status_line" }, ...(reshown.length ? [{ type: "attention" as const, kind: "awaiting" as const }] : [])],
      };
    }
    case "context_stats": {
      const st = withCategories(e.stats ?? {});
      const state = { ...s, contextLimit: st.limit ?? s.contextLimit, contextUsed: st.used ?? s.contextUsed };
      if (!e.show) return { state, effects: [] };
      return { state: { ...state, overlay: { title: "Context", lines: formatContext(st as ContextStats, modelName(s)) } }, effects: [] };
    }
    case "overlay": return { state: { ...s, overlay: { title: e.title, lines: e.lines } }, effects: [] };
    case "display":
      return { state: { ...s, display: { ...DEFAULT_DISPLAY, ...e.display }, managed: e.managed, maxAutonomy: e.maxAutonomy, ...(e.showThinking !== undefined ? { showThinking: e.showThinking } : {}) }, effects: [] };
    case "extras": return { state: { ...s, custom: e.custom, header: { ...s.header, skills: e.skills, mcps: e.mcps ?? s.header.mcps, issues: e.issues ?? s.header.issues } }, effects: [] };
    case "status_line": return { state: { ...s, statusLine: e.text || undefined, statusLineHint: e.hint, statusLinePadding: e.padding }, effects: [] };
    case "resize": return { state: { ...s, rows: e.rows, cols: e.cols }, effects: [] };
    case "open_rewind": return rewindMenu(s);
    case "rewound": {
      const i = s.items.findIndex((x) => x.kind === "user" && x.id === e.messageId);
      const items = i < 0 ? s.items : s.items.slice(0, i);
      const files = e.restoredFiles.length ? `, ${e.restoredFiles.length} file${e.restoredFiles.length === 1 ? "" : "s"} restored` : "";
      return {
        state: { ...s, items: [...items, info(`Rewound: ${e.removedCount} message${e.removedCount === 1 ? "" : "s"} removed${files}.`)], input: { text: e.text, cursor: e.text.length }, scroll: 0, pending: { steer: [], queue: [] } },
        effects: [{ type: "fetch_context", show: false }],
      };
    }
    case "info": return { state: { ...s, items: [...s.items, info(e.text, e.level ?? "info")] }, effects: [] };
    case "sessions": {
      if (!e.sessions.length) return { state: { ...s, items: [...s.items, info("No saved sessions in this folder.")] }, effects: [] };
      const panel: Panel = {
        id: "resume", kind: "select", action: { type: "resume" }, title: "Resume a session", body: [], selected: 0, checked: [],
        options: e.sessions.slice(0, 20).map((x) => ({ label: `${x.id.slice(0, 8)}  ${x.pinned ? "* " : ""}${x.title ?? "(untitled)"}${x.updatedAt ? "  " + x.updatedAt.slice(0, 16).replace("T", " ") : ""}`, value: x.id })),
      };
      return { state: { ...s, panels: [...s.panels, panel] }, effects: [] };
    }
    case "file_matches": {
      const before = s.input.text.slice(0, s.input.cursor);
      const m = /(?:^|\s)@([^\s]*)$/.exec(before);
      if (!m || m[1] !== e.query) return { state: s, effects: [] };
      return { state: { ...s, atMenu: e.items.length ? { query: e.query, items: e.items, selected: 0 } : null }, effects: [] };
    }
    case "image_pasted": return { state: { ...s, images: [...s.images, e.image], hint: `Image #${s.images.length + 1} attached (sent with your next message)` }, effects: [] };
    case "spec_edited": {
      const i = s.panels.findIndex((p) => p.kind === "exit_spec");
      if (i < 0) return { state: s, effects: [] };
      if (!e.text.trim()) return { state: { ...s, hint: "The edited spec is empty, so it was ignored" }, effects: [] };
      const p = s.panels[i];
      const at = p.options.findIndex((o) => o.value === "proceed_edit");
      const panels = s.panels.map((x, j) => (j === i ? { ...p, editedSpec: e.text, body: e.text.split("\n"), selected: at >= 0 ? at : p.selected } : x));
      return { state: { ...s, panels, hint: "Spec edited: Enter approves your version" }, effects: [] };
    }
    case "editor_result": return { state: { ...s, input: { text: e.text, cursor: e.text.length } }, effects: [] };
    case "disconnected": return { state: { ...s, running: false, working: "idle", items: [...s.items, info(e.message, "error")] }, effects: [] };
  }
}

const CATEGORY_NAMES: Record<string, string> = {
  systemPrompt: "System prompt", tools: "System tools", mcpTools: "MCP tools", userInfo: "User info", agentsMd: "AGENTS.md",
  customAgents: "Custom agents", skills: "Skills", messages: "Messages",
};
/** get_context_stats reports `breakdown` {category: tokens}; /context draws `categories` [{name, tokens}]. */
function withCategories(st: any) {
  if (st.categories || !st.breakdown) return st;
  return { ...st, categories: Object.entries(st.breakdown).map(([k, v]) => ({ name: CATEGORY_NAMES[k] ?? k, tokens: Number(v) })) };
}
