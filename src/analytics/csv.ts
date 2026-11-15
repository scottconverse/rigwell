// Fully quoted local exports, including spreadsheet formula protection for identifiers and paths.
export const CSV_KEYS = ["key", "tokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "thinkingTokens", "requests", "costUsd", "pricedCostUsd", "unpricedTokens", "cacheHitRate", "tools", "successes", "failures", "unknown", "failureRate", "turns", "durationMs", "meanTurnMs"] as const;
export function csvRows(rows: unknown[][]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/^[\s]*[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  return rows.map((row) => [...row, ...Array(Math.max(0, CSV_KEYS.length + 2 - row.length)).fill("")].map(cell).join(",")).join("\r\n") + "\r\n";
}
/** Revalidate and protect every cell at the save-dialog boundary, even for a compromised renderer. */
export function sanitizeAnalyticsCsv(content: string) {
  if (content.length > 16 * 1024 * 1024) throw new Error("Analytics CSV exceeds 16 MiB");
  const rows: string[][] = []; let row: string[] = [], i = 0;
  while (i < content.length) {
    if (content[i++] !== '"') throw new Error("Invalid analytics CSV field");
    let value = "", closed = false;
    while (i < content.length) {
      const c = content[i++];
      if (c !== '"') value += c;
      else if (content[i] === '"') { value += '"'; i++; }
      else { closed = true; break; }
    }
    if (!closed) throw new Error("Unterminated analytics CSV field");
    row.push(value);
    if (content[i] === ",") { i++; continue; }
    if (content.slice(i, i + 2) !== "\r\n" || row.length !== CSV_KEYS.length + 2) throw new Error("Invalid analytics CSV row");
    i += 2; rows.push(row); row = [];
  }
  if (row.length || JSON.stringify(rows[0]) !== JSON.stringify(["section", "group", ...CSV_KEYS])) throw new Error("Invalid analytics CSV header");
  return csvRows(rows);
}
