// Raw stdin bytes -> Key events. Handles CSI/SS3 sequences, Alt+key, Ctrl+Enter variants and bracketed paste.
import type { Key } from "./types.ts";

export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";

const CSI_FINAL: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift+tab",
};
const TILDE: Record<string, string> = { "1": "home", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };

export function parseKeys(data: string): Key[] {
  const out: Key[] = [];
  let i = 0;
  let text = "";
  const flush = () => { if (text) { out.push({ name: "char", text }); text = ""; } };
  while (i < data.length) {
    const c = data[i];
    if (c === "\x1b") {
      flush();
      if (data.startsWith("\x1b[200~", i)) {
        const end = data.indexOf("\x1b[201~", i + 6);
        const body = end < 0 ? data.slice(i + 6) : data.slice(i + 6, end);
        out.push({ name: "paste", text: body.replace(/\r\n?/g, "\n") });
        i = end < 0 ? data.length : end + 6;
        continue;
      }
      const n = data[i + 1];
      if (n === "[" || n === "O") {
        let j = i + 2;
        while (j < data.length && /[0-9;?]/.test(data[j])) j++;
        const params = data.slice(i + 2, j);
        const fin = data[j] ?? "";
        i = j + 1;
        const mod = Number(params.split(";")[1] ?? 1) - 1; // 1=shift 2=alt 4=ctrl bit flags
        const alt = !!(mod & 2), ctrl = !!(mod & 4);
        if (fin === "~") {
          const base = params.split(";")[0];
          if (base === "27") { // xterm modifyOtherKeys: ESC[27;mod;13~
            const code = Number(params.split(";")[2]);
            if (ctrl && (mod & 1) && (code === 67 || code === 99)) out.push({ name: "ctrl+shift+c" });
            else if (code === 13) out.push({ name: ctrl ? "ctrl+enter" : alt ? "alt+enter" : "enter" });
            continue;
          }
          const name = TILDE[base];
          if (name) out.push({ name: alt ? `alt+${name}` : name });
        } else if (fin === "u") { // kitty keyboard protocol: ESC[code;modu
          const code = Number(params.split(";")[0]);
          if (ctrl && (mod & 1) && (code === 67 || code === 99)) out.push({ name: "ctrl+shift+c" }); // kitty: Ctrl+Shift+C
          else if (code === 13) out.push({ name: ctrl ? "ctrl+enter" : alt ? "alt+enter" : "enter" });
          else if (code === 27) out.push({ name: "esc" });
          else if (ctrl && code >= 97 && code <= 122) out.push({ name: `ctrl+${String.fromCharCode(code)}` });
        } else if (CSI_FINAL[fin]) {
          const name = CSI_FINAL[fin];
          out.push({ name: alt && !ctrl ? `alt+${name}` : name });
        }
        continue;
      }
      if (n === undefined) { out.push({ name: "esc" }); i++; continue; }
      // Alt + key
      i += 2;
      if (n === "\r" || n === "\n") out.push({ name: "alt+enter" });
      else if (n === "\x7f") out.push({ name: "alt+backspace" });
      else out.push({ name: `alt+${n.toLowerCase()}` });
      continue;
    }
    i++;
    switch (c) {
      case "\r": if (data[i] === "\n") i++; flush(); out.push({ name: "enter" }); break;
      case "\n": flush(); out.push({ name: "enter" }); break;
      case "\t": flush(); out.push({ name: "tab" }); break;
      case "\x7f": case "\b": flush(); out.push({ name: "backspace" }); break;
      default: {
        const code = c.charCodeAt(0);
        if (code < 32) { flush(); out.push({ name: `ctrl+${String.fromCharCode(code + 96)}` }); } else text += c;
      }
    }
  }
  flush();
  return out;
}
