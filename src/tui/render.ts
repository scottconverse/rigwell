// Pure renderer: (state, size) -> screen lines and cursor position (spec §13.1). No terminal I/O here.
import { AUTONOMY_STATUS } from "./commands.ts";
import { contextPercent, slashMenu } from "./reducer.ts";
import type { Item, Panel, TuiState } from "./types.ts";

export interface RenderOptions { width: number; height: number; color?: boolean }
export interface Screen { lines: string[]; cursor: { row: number; col: number } | null }

import { stripAnsi, styler, todoLines, transcriptLines, transcriptOpts, wrapText } from "./transcript.ts";
import { isAddedLine, isRemovedLine } from "./diff.ts";
export { stripAnsi, wrapText };

const loaded = (n: number) => (n > 0 ? `Loaded +${n}` : "Not found");
const TIPS = ["Press ? for help.", "Shift+Tab switches to spec mode to plan before editing.", "Use @ to pick a file path and ! to run a shell command."];

const commentKind = (p: Panel) => p.kind === "permission" || p.kind === "batch" || p.kind === "exit_spec";

function panelLines(p: Panel, s: TuiState, w: number, maxBody: number, st: ReturnType<typeof styler>): string[] {
  const out: string[] = [];
  const reqs = s.panels.filter((x) => x.action.type === "request");
  if (reqs.length > 1 && p.action.type === "request") out.push(st.dim(`Approval ${reqs.indexOf(p) + 1} of ${reqs.length}`));
  out.push(st.bold(p.title) + (p.tag ? " " + st.dim(p.tag) : ""));
  const body = p.body.flatMap((l) => wrapText(l, w - 2));
  const limit = s.detailed ? body.length : Math.max(3, maxBody);
  for (const l of body.slice(0, limit)) out.push("  " + (isAddedLine(l) ? st.green(l) : isRemovedLine(l) ? st.red(l) : l.startsWith("@@") ? st.cyan(l) : l));
  if (body.length > limit) out.push(st.dim(`  ... ${body.length - limit} more lines (Ctrl+O to expand)`));
  if (p.savePath) out.push(`  Will save to: ${p.savePath}`);
  out.push("");
  p.options.forEach((o, i) => {
    const mark = p.multi ? (p.checked.includes(i) ? "[x] " : "[ ] ") : "";
    const line = `${i === p.selected ? "›" : " "} ${i + 1}. ${mark}${o.label}`;
    out.push(i === p.selected ? st.cyan(line) : line);
  });
  if (p.other?.typing) {
    out.push(`  Your answer: ${p.other.text}_`);
    out.push(st.dim("Type your answer · Enter sends it · Esc goes back to the options"));
    return out;
  }
  if (p.commentMode || p.comment) {
    const label = p.kind === "exit_spec" ? "Add guidance for the implementation" : "Comment";
    out.push(`  ${label}: ${p.comment ?? ""}${p.commentMode ? "_" : ""}`);
  }
  if (p.editedSpec !== undefined) out.push(st.dim("  (the spec above is your edited version)"));
  const extra = p.kind === "exit_spec" ? " · Ctrl+G edit the plan" : "";
  if (p.commentMode) out.push(st.dim("Type your comment · Up/Down pick the option · Enter sends · Tab or Esc back to the options"));
  else if (commentKind(p)) out.push(st.dim(`Up/Down move · Enter selects · 1-${Math.min(9, p.options.length)} quick select · Tab add a comment${extra} · Esc cancels`));
  else out.push(st.dim(p.multi ? "Up/Down move · Space toggles · Enter confirms · Esc cancels" : `Up/Down move · Enter selects · 1-${Math.min(9, p.options.length)} quick select · Esc cancels`));
  return out;
}

export function render(s: TuiState, o: RenderOptions): Screen {
  const W = Math.max(20, o.width), H = Math.max(6, o.height);
  const st = styler(o.color ?? true, s.theme);
  const rule = st.dim("─".repeat(W));

  // ---- bottom block: pending, prompt area, status, footer
  const bottom: string[] = [];
  const { steer, queue } = s.pending;
  if (steer.length || queue.length) {
    if (steer.length) { bottom.push(st.dim("Steering messages:")); steer.forEach((t) => bottom.push("  " + t.split("\n")[0].slice(0, W - 4))); }
    if (queue.length) { bottom.push(st.dim("Queued messages:")); queue.forEach((t) => bottom.push("  " + t.split("\n")[0].slice(0, W - 4))); }
    bottom.push(st.dim("Ctrl+R review · Ctrl+G pull the top · Ctrl+X clear"));
  }
  // todoDisplayMode "pinned": the todo list stays above the prompt (inline puts it in the transcript instead).
  if (s.display.todoDisplayMode === "pinned" && s.todos.length && !s.overlay) {
    const open = s.todos.filter((t) => t.status !== "completed").length;
    bottom.push(st.dim(`Todos (${s.todos.length - open}/${s.todos.length} done)`));
    const lines = todoLines(s.todos, W);
    bottom.push(...lines.slice(0, 8));
    if (lines.length > 8) bottom.push(st.dim(`  ... ${lines.length - 8} more`));
  }
  let cursor: Screen["cursor"] = null;
  let cursorInBottom: { row: number; col: number } | null = null;
  const reserved = 2; // status + footer
  if (s.panels.length) {
    bottom.push(rule);
    bottom.push(...panelLines(s.panels[0], s, W, Math.max(3, H - bottom.length - reserved - 8), st));
  } else if (!s.overlay) {
    bottom.push(rule);
    const prefix = s.shellMode ? "! " : "> ";
    const cw = W - 2;
    if (!s.input.text) {
      const ph = s.running ? "Enter to steer · Ctrl+Enter to queue" : s.mode === "spec" ? "research and plan first" : "Type a message, / for commands, @ for files, ! for shell";
      bottom.push(prefix + st.dim(ph));
      cursorInBottom = { row: bottom.length - 1, col: 2 };
    } else {
      let row = bottom.length, curRow = row, curCol = 2, offset = 0;
      s.input.text.split("\n").forEach((ln, li) => {
        const chunks = ln.length ? Array.from({ length: Math.ceil(ln.length / cw) }, (_, k) => ln.slice(k * cw, (k + 1) * cw)) : [""];
        chunks.forEach((c, k) => {
          bottom.push((li === 0 && k === 0 ? prefix : "  ") + c);
          const start = offset + k * cw;
          if (s.input.cursor >= start && s.input.cursor <= start + c.length && (s.input.cursor < start + cw || k === chunks.length - 1)) { curRow = row; curCol = 2 + s.input.cursor - start; }
          row++;
        });
        offset += ln.length + 1;
      });
      cursorInBottom = { row: curRow, col: curCol };
    }
    if (s.images.length) bottom.push(st.dim(s.images.map((_, i) => `[Image #${i + 1}]`).join(" ") + "  (sent with your next message)"));
    if (s.vim) bottom.push(st.dim(s.vimMode === "normal" ? "-- NORMAL --" : "-- INSERT --"));
    const menu = slashMenu(s);
    if (menu.length) {
      const sel = Math.min(s.menuIndex, menu.length - 1);
      menu.slice(0, 8).forEach((c, i) => {
        const line = `${i === sel ? "▶" : " "} /${c.name}${c.args ? " " + c.args : ""}  ${c.desc}`.slice(0, W);
        bottom.push(i === sel ? st.cyan(line) : st.dim(line));
      });
    } else if (s.atMenu?.items.length) {
      s.atMenu.items.slice(0, 8).forEach((f, i) => {
        const line = `${i === s.atMenu!.selected ? "▶" : " "} @${f}`.slice(0, W);
        bottom.push(i === s.atMenu!.selected ? st.cyan(line) : st.dim(line));
      });
    }
  }

  // status bar
  const left: string[] = [s.mode === "spec" ? "Spec · research and plan first" : AUTONOMY_STATUS[s.autonomy] ?? s.autonomy];
  const mname = s.models.find((m) => m.id === s.modelId)?.displayName ?? s.modelId;
  if (mname) left.push(mname);
  if (s.reasoning) left.push(s.reasoning);
  if (!s.autoCompress) left.push("auto-compress off");
  if (s.sandbox) left.push("SANDBOX");
  if (s.shellMode) left.push("Bash mode active • Esc to exit");
  const right: string[] = [];
  if (s.running && s.runStartedAt !== undefined) right.push(`${Math.max(0, Math.floor((s.now - s.runStartedAt) / 1000))}s`);
  const pct = contextPercent(s);
  right.push(`context: ${pct ?? "n/a"}`);
  let l = left.join(" · "), r = right.join(" · ");
  if (l.length + r.length + 1 > W) l = l.slice(0, Math.max(0, W - r.length - 2)) + "…";
  const status = st.inverse(l + " ".repeat(Math.max(1, W - l.length - r.length)) + r);
  const footer = st.dim(("? for help" + (s.header.issues ? ` · ${s.header.issues} config issue${s.header.issues === 1 ? "" : "s"}: /diagnostics` : "") + (s.scroll > 0 ? " · scrolled: PageDown / Alt+PgDn for newer" : "") + (s.hint ? " · " + s.hint : "")).slice(0, W));
  if (s.statusLine || s.statusLineHint) {
    const pad = " ".repeat(Math.min(10, s.statusLinePadding ?? 0));
    for (const l of (s.statusLine ?? s.statusLineHint ?? "").split("\n")) bottom.push((pad + l).slice(0, W));
  }
  bottom.push(status, footer);

  // ---- top region
  const topH = Math.max(0, H - bottom.length);
  let top: string[];
  if (s.overlay) {
    top = [st.bold(s.overlay.title), rule, ...s.overlay.lines.flatMap((x) => wrapText(x, W - 1)), "", st.dim("Esc closes")];
    top = top.slice(0, topH);
  } else {
    const header = [
      st.bold("Rigwell") + st.dim(`  v${s.version} · a local coding agent`),
      st.dim(s.cwd),
      st.dim(`Skills: ${loaded(s.header.skills)} · MCPs: ${loaded(s.header.mcps)} · AGENTS.md: ${s.header.agentsMd ? "Loaded" : "Not found"}`),
      st.dim("Tip: " + TIPS[s.counter % TIPS.length]),
      st.dim("Enter send · Ctrl+Enter queue · Esc cancel · Shift+Tab mode · Ctrl+L autonomy · Ctrl+O details"),
      st.dim("/ commands · @ files · ! shell · ? help"),
      "",
    ].map((x) => (stripAnsi(x).length > W ? x.slice(0, W) : x));
    const body = transcriptLines(s.items, { ...transcriptOpts(s), width: W }, st).lines;
    top = [...header, ...body];
    if (top.length > topH) {
      const scroll = Math.min(s.scroll, top.length - topH);
      const end = top.length - scroll;
      top = top.slice(end - topH, end);
      if (scroll > 0) top[top.length - 1] = st.dim(`  ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below (PageDown)`);
    }
  }
  const lines = [...top, ...Array(Math.max(0, topH - top.length)).fill(""), ...bottom].slice(-H);
  if (cursorInBottom) cursor = { row: Math.max(0, lines.length - bottom.length) + cursorInBottom.row - 0, col: Math.min(W - 1, cursorInBottom.col) };
  return { lines, cursor };
}
