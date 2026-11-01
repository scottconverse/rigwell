// Tiny syntax highlighter for the file viewer: strings, comments, numbers and keywords for common languages.
// Returns safe HTML (input is escaped first). Not a parser; good enough to make code readable.
import { escapeHtml } from "./markdown.ts";

const KEYWORDS = new Set((
  "abstract as async await break case catch class const continue def default delete do else enum export extends false finally fn for from function " +
  "if impl import in interface is let match mod new none None null of package private protected pub public return self static struct super switch this " +
  "throw true True False try type typeof use var void while with yield func go defer chan select elif lambda pass raise except not and or"
).split(" "));

const LINE_COMMENT: Record<string, string> = { py: "#", sh: "#", yml: "#", yaml: "#", toml: "#", rb: "#", css: "", json: "" };

export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext;
}

export function highlight(code: string, path: string): string {
  const ext = languageOf(path);
  if (ext === "md" || ext === "markdown") return escapeHtml(code);
  const lc = ext in LINE_COMMENT ? LINE_COMMENT[ext] : "//";
  const re = new RegExp(
    [
      "(\\/\\*[\\s\\S]*?\\*\\/)", // block comment
      lc ? `(${lc.replace(/[/#]/g, "\\$&")}[^\\n]*)` : "(?!x)x", // line comment
      "(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)", // string
      "(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)", // number
      "(\\b[A-Za-z_][A-Za-z0-9_]*\\b)", // word
    ].join("|"), "g");
  let out = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += escapeHtml(code.slice(last, m.index));
    last = m.index! + m[0].length;
    const [all, block, line, str, num, word] = m;
    const e = escapeHtml(all);
    if (block || line) out += `<span class="tk-c">${e}</span>`;
    else if (str) out += `<span class="tk-s">${e}</span>`;
    else if (num) out += `<span class="tk-n">${e}</span>`;
    else if (word && KEYWORDS.has(word)) out += `<span class="tk-k">${e}</span>`;
    else out += e;
  }
  return out + escapeHtml(code.slice(last));
}
