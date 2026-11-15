import { isAbsolute } from "node:path";
import { lstatSync, writeFileSync } from "node:fs";
import { buildDiagnosticBundle, recordCrash } from "../../src/diagnostics/reports.ts";

export function rendererCrashReceiver(home: string) {
  const counts = new Map<number, { at: number; count: number }>();
  return (sender: number, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid renderer crash report");
    const p = value as Record<string, unknown>;
    if (Object.keys(p).some((k) => !["kind", "detail"].includes(k)) || typeof p.kind !== "string" || p.kind.length > 100 || typeof p.detail !== "string" || p.detail.length > 24000) throw new Error("Invalid renderer crash fields");
    const now = Date.now(), prev = counts.get(sender), current = prev && now - prev.at < 60000 ? prev : { at: now, count: 0 };
    if (++current.count > 10) return false; counts.set(sender, current); if (counts.size > 100) for (const [id, c] of counts) if (now - c.at > 60000) counts.delete(id);
    return !!recordCrash(home, "renderer", p.kind, p.detail);
  };
}
export async function saveBugReport(home: string, versions: Record<string, string | undefined>, choose: () => Promise<string | null>, build = buildDiagnosticBundle) {
  const file = await choose(); if (!file) return null;
  if (!isAbsolute(file) || !file.toLowerCase().endsWith(".zip")) throw new Error("Choose an absolute .zip diagnostic path");
  try { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error("Refusing linked or nonregular export target"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const bundle = build(home, versions); writeFileSync(file, bundle.bytes, { mode: 0o600 }); return { file, files: bundle.files, omitted: bundle.omitted };
}
