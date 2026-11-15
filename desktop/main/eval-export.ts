import { isAbsolute } from "node:path";
import { writeFile } from "node:fs/promises";
import { encodeCsv, parseCsv, RESULT_HEADERS } from "../../src/eval/csv.ts";

export async function saveEvalExport(format: unknown, content: unknown, choose: (extension: "csv" | "jsonl") => Promise<string | null>) {
  if ((format !== "csv" && format !== "jsonl") || typeof content !== "string" || Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error("Invalid evaluation export");
  let safe: string;
  if (format === "csv") { const rows = parseCsv(content); if (JSON.stringify(rows[0]) !== JSON.stringify(RESULT_HEADERS) || rows.some((r) => r.length !== RESULT_HEADERS.length)) throw new Error("Invalid result CSV"); safe = encodeCsv(rows); }
  else { safe = content.split(/\r?\n/).filter((l) => l.trim()).map((l) => { const value = JSON.parse(l); if (value?.schema !== 1 || typeof value.task !== "string" || typeof value.model !== "string") throw new Error("Invalid result JSONL"); return JSON.stringify(value); }).join("\n") + "\n"; }
  const file = await choose(format); if (!file) return null;
  if (!isAbsolute(file) || !file.toLowerCase().endsWith(`.${format}`)) throw new Error(`Choose an absolute .${format} export path`);
  await writeFile(file, safe, { mode: 0o600, encoding: "utf8" }); return file;
}
