// Transcript layout shared by the renderer and the reducer (scroll keys need line counts). Pure.
import type { Item, TuiState } from "./types.ts";

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

export function itemLines(i: Item, o: { width: number; detailed: boolean; showThinking: boolean }, st: ReturnType<typeof styler>): string[] {
  const w = o.width;
  switch (i.kind) {
    case "user": {
      const l = wrapText(i.text, w - 2);
      return [...l.map((x, n) => st.bold((n === 0 ? "> " : "  ") + x)), ""];
    }
    case "assistant": return [...wrapText(i.text, w - 2).map((x, n) => (n === 0 ? "● " : "  ") + x), ""];
    case "thinking": return o.showThinking ? [...wrapText("thinking: " + i.text, w - 2).map((x) => st.dim("  " + x)), ""] : [];
    case "info": return wrapText(i.text, w - 2).map((x) => (i.level === "error" ? st.red("! " + x) : st.dim("  " + x)));
    case "tool": {
      const icon = i.status === "running" ? st.yellow("…") : i.status === "ok" ? st.green("✓") : st.red("✗");
      const head = `${o.detailed ? "▾" : "▸"} ${i.name}${toolSummary(i) ? " " + toolSummary(i) : ""}`;
      const out = [`  ${head.length > w - 6 ? head.slice(0, w - 7) + "…" : head} ${icon}`];
      if (o.detailed) {
        const inputText = JSON.stringify(i.input ?? {}, null, 2).split("\n").flatMap((l) => wrapText(l, w - 6));
        out.push(...inputText.map((l) => st.dim("      " + l)));
        const res = i.output ?? i.live;
        if (res) {
          const lines = res.split("\n").flatMap((l) => wrapText(l, w - 6));
          out.push(...lines.slice(0, 40).map((l) => "      " + l));
          if (lines.length > 40) out.push(st.dim(`      ... ${lines.length - 40} more lines`));
        }
      }
      return out;
    }
  }
}


export type Styler = ReturnType<typeof styler>;

export interface TranscriptOpts { width: number; detailed: boolean; showThinking: boolean }

/** Lines of the transcript items (without the header) and the line index where each user turn starts. */
export function transcriptLines(items: Item[], o: TranscriptOpts, st: Styler): { lines: string[]; userStarts: number[] } {
  const lines: string[] = [];
  const userStarts: number[] = [];
  for (const i of items) {
    if (i.kind === "user") userStarts.push(lines.length);
    lines.push(...itemLines(i, o, st));
  }
  return { lines, userStarts };
}

export const plainStyler = () => styler(false, "dark");
export type { TuiState };
