import { isAbsolute } from "node:path";
import { writeFile } from "node:fs/promises";
import { sanitizeAnalyticsCsv } from "../../src/analytics/csv.ts";

export async function saveAnalyticsExport(content: unknown, choose: () => Promise<string | null>) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 16 * 1024 * 1024 || !content.startsWith('"section","group","key",')) throw new Error("Invalid analytics CSV");
  const safe = sanitizeAnalyticsCsv(content), file = await choose(); if (!file) return null;
  if (!isAbsolute(file) || !file.toLowerCase().endsWith(".csv")) throw new Error("Choose an absolute .csv export path");
  await writeFile(file, safe, { encoding: "utf8", mode: 0o600 }); return file;
}
