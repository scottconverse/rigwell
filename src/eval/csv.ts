export const RESULT_HEADERS = ["build", "startedAt", "task", "model", "variant", "trial", "passed", "failKind", "wallMs", "requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "priced", "checkPassed", "judgeModel", "judgeScore", "judgeStatus", "answer", "transcript"];
export function parseCsv(text: string): string[][] {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("CSV exceeds 16 MiB");
  text = text.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false;
  const cell = () => { row.push(value); value = ""; closed = false; if (row.length > 256) throw new Error("CSV exceeds 256 columns"); };
  const line = () => { cell(); if (row.some((v) => v !== "")) rows.push(row); row = []; if (rows.length > 10001) throw new Error("CSV exceeds 10000 data rows"); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; }
    else if (c === ",") cell();
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; line(); }
    else if (c === '"' && !value && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error("Invalid CSV quoting"); value += c; }
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (value || row.length || closed) line();
  return rows;
}
export function encodeCsv(rows: unknown[][]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
