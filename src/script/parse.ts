// Script input parsing (spec §5.2, prompts §5.9): optional `//@background` first line, optional
// `//@input name <<MARKER` blocks, then the code. Blocks are raw: nothing inside is escaped.

export const MAX_INPUT_BYTES = 1024 * 1024;

export interface ParsedScript {
  background: boolean;
  inputs: Record<string, string>;
  /** The code, padded with blank lines where the header was so error line numbers match the input. */
  code: string;
}

const INPUT_RE = /^\/\/@input\s+([A-Za-z_$][\w$]*)\s*<<\s*(\S+)\s*$/;

export function parseScript(text: string): ParsedScript | { error: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let background = false;
  if (/^\/\/@background\s*$/.test(lines[0] ?? "")) {
    background = true;
    i = 1;
  }
  const inputs: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (;;) {
    // Blank lines between header parts are allowed.
    let j = i;
    while (j < lines.length && lines[j]!.trim() === "") j++;
    const m = INPUT_RE.exec(lines[j] ?? "");
    if (!m) break;
    const [, name, marker] = m as unknown as [string, string, string];
    let end = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k] === marker) { end = k; break; }
    }
    if (end < 0) return { error: `Input block "${name}" is not closed: no line that is exactly ${marker}.` };
    if (name in inputs) return { error: `Input block "${name}" is defined twice.` };
    const body = lines.slice(j + 1, end).join("\n");
    bytes += Buffer.byteLength(body);
    if (bytes > MAX_INPUT_BYTES) return { error: `Input blocks are over the 1 MiB limit (${bytes} bytes).` };
    inputs[name] = body;
    i = end + 1;
  }
  return { background, inputs: { ...inputs }, code: "\n".repeat(i) + lines.slice(i).join("\n") };
}
