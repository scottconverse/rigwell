// Transcript layout shared by the renderer and the reducer (scroll keys need line counts). Pure.
import { diffBody, type DiffMode } from "./diff.ts";
import { DEFAULT_DISPLAY, type DisplaySettings, type Item, type TuiState } from "./types.ts";

const ANSI_RE = new RegExp("\\x1b\\[[0-9;?]*[A-Za-z]", "g");
export const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

/** Word-wrap plain text to `width`, keeping explicit newlines and hard-cutting long words. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\t/g, "  ");
    if (line.length <= w) { out.push(line); continue; }
    while (line.length > w) {
      let cut = line.lastIndexOf(" ", w);
      if (cut <= 0) cut = w;
      out.push(line.slice(0, cut));
      line = line.slice(cut).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

export function styler(color: boolean, theme: "dark" | "light") {
  const wrap = (code: string) => (t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  return {
    bold: wrap("1"), dim: wrap(theme === "dark" ? "2" : "90"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"),
    cyan: wrap(theme === "dark" ? "36" : "34"), inverse: wrap("7"),
  };
}

function toolSummary(i: Extract<Item, { kind: "tool" }>): string {
  const inp = i.input ?? {};
  const v = inp.path ?? inp.file_path ?? inp.command ?? inp.pattern ?? inp.query ?? inp.url ?? "";
  return String(v).split("\n")[0];
}

export const TODO_MARK: Record<string, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

/** Todo list lines (pinned block and inline items). */
export function todoLines(todos: { content: string; status: string }[], w: number): string[] {
  return todos.flatMap((t) => wrapText(`${TODO_MARK[t.status] ?? "[ ]"} ${t.content}`, w - 4).map((l, n) => (n === 0 ? "  " : "      ") + l));
}

export interface ItemOpts {
  width: number; detailed: boolean; showThinking: boolean;
  display?: DisplaySettings;
  /** This item is the last one and the agent is still working: an assistant message may still be streaming. */
  live?: boolean;
}

/** Colours a diff body line: green added, red removed, cyan hunk header. */
function diffColor(l: string, st: ReturnType<typeof styler>): string {
  if (l.startsWith("+") && !l.startsWith("+++ ")) return st.green(l);
  if (l.startsWith("-") && !l.startsWith("--- ")) return st.red(l);
  if (l.startsWith("@@")) return st.cyan(l);
  return l;
}

/** Edit and Create calls show their change as a diff in the mode the `diffMode` setting names. */
function toolDiff(i: Extract<Item, { kind: "tool" }>, mode: DiffMode): string[] | null {
  const inp = i.input ?? {};
  const p = String(inp.path ?? "");
  if (i.name === "Edit" && typeof inp.old_text === "string" && typeof inp.new_text === "string") return diffBody(inp.old_text, inp.new_text, mode, p);
  if (i.name === "Create" && typeof inp.content === "string") return diffBody(undefined, inp.content, mode, p);
  return null;
}

export function itemLines(i: Item, o: ItemOpts, st: ReturnType<typeof styler>): string[] {
  const w = o.width;
  const d = o.display ?? DEFAULT_DISPLAY;
  const plain = d.outputStyle === "plain";
  const compact = d.outputStyle === "compact";
  const gap = compact ? [] : [""];
  switch (i.kind) {
    case "user": {
      const l = wrapText(i.text, w - 2);
      return [...l.map((x, n) => st.bold((n === 0 ? "> " : "  ") + x)), ...gap];
    }
    case "assistant":
      // streamAssistantResponses=false: the message shows once it is finished.
      if (!d.streamAssistantResponses && o.live) return [st.dim(plain ? "  (writing)" : "● …"), ...gap];
      return [...wrapText(i.text, w - 2).map((x, n) => (plain ? "  " : n === 0 ? "● " : "  ") + x), ...gap];
    case "thinking": return o.showThinking ? [...wrapText("thinking: " + i.text, w - 2).map((x) => st.dim("  " + x)), ...gap] : [];
    case "info": return wrapText(i.text, w - 2).map((x) => (i.level === "error" ? st.red("! " + x) : st.dim("  " + x)));
    case "todos": return i.todos.length ? [st.dim("  Todos"), ...todoLines(i.todos, w), ...gap] : [];
    case "btw": {
      const head = st.cyan(`btw> ${i.question}`);
      const body = i.status === "pending" ? [st.dim("  (waiting for the side chat)")] : wrapText(i.answer || (i.status === "error" ? "The side chat failed." : ""), w - 4).map((x) => "  " + x);
      return [...wrapText(head, w), ...body, ...(i.status === "streaming" ? [st.dim("  …")] : []), ...gap];
    }
    case "tool": {
      const sym = plain
        ? (i.status === "running" ? "(running)" : i.status === "ok" ? "(ok)" : "(error)")
        : i.status === "running" ? "…" : i.status === "ok" ? "✓" : "✗";
      const icon = i.status === "running" ? st.yellow(sym) : i.status === "ok" ? st.green(sym) : st.red(sym);
      const open = o.detailed || (d.toolResultDisplay === "expanded" && i.status !== "running");
      const head = `${plain ? "" : o.detailed ? "▾ " : "▸ "}${i.name}${toolSummary(i) ? " " + toolSummary(i) : ""}`;
      const out = [`  ${head.length > w - 6 ? head.slice(0, w - 7) + "…" : head} ${icon}`];
      const diff = toolDiff(i, d.diffMode);
      if (o.detailed) {
        if (diff) out.push(...diff.flatMap((l) => wrapText(l, w - 6)).map((l) => "      " + diffColor(l, st)));
        else {
          const inputText = JSON.stringify(i.input ?? {}, null, 2).split("\n").flatMap((l) => wrapText(l, w - 6));
          out.push(...inputText.map((l) => st.dim("      " + l)));
        }
      } else if (open && diff) {
        out.push(...diff.slice(0, 12).flatMap((l) => wrapText(l, w - 6)).map((l) => "      " + diffColor(l, st)));
      }
      if (open) {
        const res = i.output ?? i.live;
        // expanded (not detailed) results are cut to 8 lines; Ctrl+O shows up to 40
        const cap = o.detailed ? 40 : 8;
        if (res) {
          const lines = res.split("\n").flatMap((l) => wrapText(l, w - 6));
          out.push(...lines.slice(0, cap).map((l) => "      " + l));
          if (lines.length > cap) out.push(st.dim(`      ... ${lines.length - cap} more lines`));
        }
      }
      return out;
    }
  }
}


export type Styler = ReturnType<typeof styler>;

export type TranscriptOpts = ItemOpts;

/** The options the renderer and the scroll keys pass for a state. */
export const transcriptOpts = (s: TuiState): TranscriptOpts => ({ width: s.cols, detailed: s.detailed, showThinking: s.showThinking, display: s.display, live: s.running });

/** Lines of the transcript items (without the header) and the line index where each user turn starts. */
export function transcriptLines(items: Item[], o: TranscriptOpts, st: Styler): { lines: string[]; userStarts: number[] } {
  const lines: string[] = [];
  const userStarts: number[] = [];
  items.forEach((i, n) => {
    if (i.kind === "user") userStarts.push(lines.length);
    lines.push(...itemLines(i, { ...o, live: o.live === true && n === items.length - 1 }, st));
  });
  return { lines, userStarts };
}

export const plainStyler = () => styler(false, "dark");
export type { TuiState };
