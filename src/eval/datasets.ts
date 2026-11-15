import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskDef } from "./types.ts";
import { evalDir } from "./store.ts";
import { unlinkedPath } from "../sync/target.ts";
import { makePrivate } from "../platform/private.ts";
import { parseCsv } from "./csv.ts";

export interface DatasetRow { id: string; prompt: string; expectedOutput?: string; output?: string; rubric?: string }
export interface Dataset { schema: 1; id: string; name: string; createdAt: string; source: "csv" | "jsonl" | "stax"; sourceHash: string; staxVerified: false; rows: DatasetRow[] }
export type ColumnMap = Partial<Record<keyof DatasetRow, string>>;
const root = () => join(evalDir(), "datasets");
function file(id: string) { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid dataset id"); return unlinkedPath(join(root(), `${id}.json`)); }
function bounded(file: string) { unlinkedPath(file); const st = lstatSync(file); if (!st.isFile() || st.size > 16 * 1024 * 1024) throw new Error("Select a regular dataset file of at most 16 MiB"); return readFileSync(file, "utf8"); }
export function normalizeRows(rows: unknown[]): DatasetRow[] {
  if (!rows.length || rows.length > 10000) throw new Error("Dataset needs 1 to 10000 rows");
  const ids = new Set<string>();
  return rows.map((row: any, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Row ${i + 1} must be an object`);
    const id = row.id === undefined || row.id === "" ? `row-${i + 1}` : row.id;
    if (typeof id !== "string" || !id || id.length > 200 || ids.has(id)) throw new Error(`Row ${i + 1} needs a unique id`); ids.add(id);
    if (typeof row.prompt !== "string" || !row.prompt.trim() || Buffer.byteLength(row.prompt) > 65536) throw new Error(`Row ${i + 1} needs a prompt of at most 64 KiB`);
    const result: DatasetRow = { id, prompt: row.prompt };
    for (const key of ["expectedOutput", "output", "rubric"] as const) if (row[key] !== undefined && row[key] !== "") { if (typeof row[key] !== "string" || Buffer.byteLength(row[key]) > 65536) throw new Error(`Row ${i + 1} has invalid ${key}`); result[key] = row[key]; }
    return result;
  });
}
export function previewDataset(source: string, format: Dataset["source"], columns?: ColumnMap) {
  if (!["csv", "jsonl", "stax"].includes(format)) throw new Error("Choose CSV or JSONL; Stax CSV needs explicit column mapping and a real export for verification");
  const text = bounded(source); let rows: unknown[], discarded: string[] = [];
  if (format === "jsonl") {
    rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`Invalid JSONL at row ${i + 1}`); } });
    discarded = [...new Set(rows.flatMap((r: any) => r && typeof r === "object" ? Object.keys(r).filter((k) => !["id", "prompt", "expectedOutput", "output", "rubric"].includes(k)) : []))];
  } else {
    if (format === "stax" && !columns?.prompt) throw new Error("Map the Stax CSV prompt column explicitly. Its export schema is not yet verified against the owner's real file.");
    const parsed = parseCsv(text), headers = parsed.shift(); if (!headers?.length || new Set(headers).size !== headers.length) throw new Error("CSV needs distinct column headers");
    const mapping: ColumnMap = columns ?? { id: "id", prompt: "prompt", expectedOutput: "expectedOutput", output: "output", rubric: "rubric" };
    if (!mapping.prompt || !headers.includes(mapping.prompt)) throw new Error("Map an existing prompt column");
    for (const [key, value] of Object.entries(mapping)) if (!["id", "prompt", "expectedOutput", "output", "rubric"].includes(key) || typeof value !== "string") throw new Error("Invalid dataset column mapping");
    if (columns && Object.values(columns).some((h) => !headers.includes(h!))) throw new Error("Mapped column is missing from the CSV");
    discarded = headers.filter((h) => !Object.values(mapping).includes(h));
    rows = parsed.map((cells, i) => { if (cells.length !== headers.length) throw new Error(`CSV row ${i + 1} has the wrong column count`); return Object.fromEntries(Object.entries(mapping).filter(([, h]) => headers.includes(h!)).map(([key, h]) => [key, cells[headers.indexOf(h!)]])); });
  }
  const normalized = normalizeRows(rows), sourceHash = createHash("sha256").update(text).digest("hex");
  return { rows: normalized, discarded, sourceHash, previewHash: createHash("sha256").update(JSON.stringify({ sourceHash, format, rows: normalized })).digest("hex"), staxVerified: false as const, warning: format === "stax" ? "Explicit mapped CSV conversion only. Real Stax export compatibility remains unverified." : "Data only. Unknown fields are discarded; no imported command or script is executed." };
}
export function importDataset(o: { source: string; format: Dataset["source"]; columns?: ColumnMap; name: string; previewHash: string; confirmed: boolean }) {
  if (o.confirmed !== true) throw new Error("Confirm this dataset import");
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 200) throw new Error("Dataset name must be 1 to 200 characters");
  const preview = previewDataset(o.source, o.format, o.columns); if (o.previewHash !== preview.previewHash) throw new Error("Dataset or mapping changed since preview; preview it again");
  const dataset: Dataset = { schema: 1, id: crypto.randomUUID(), name: o.name.trim(), createdAt: new Date().toISOString(), source: o.format, sourceHash: preview.sourceHash, staxVerified: false, rows: preview.rows };
  unlinkedPath(root()); mkdirSync(root(), { recursive: true }); if (!makePrivate(root(), { dir: true })) throw new Error("Could not protect dataset storage");
  writeFileSync(file(dataset.id), JSON.stringify(dataset), { flag: "wx", mode: 0o600 }); return dataset;
}
export function readDataset(id: string): Dataset {
  const value = JSON.parse(bounded(file(id))); if (value?.schema !== 1 || value.id !== id || typeof value.name !== "string") throw new Error("Invalid dataset"); return { ...value, rows: normalizeRows(value.rows) };
}
export function listDatasets() {
  let names: string[] = []; try { names = readdirSync(unlinkedPath(root())); } catch { return []; }
  return names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).flatMap((n) => { try { const d = readDataset(n.slice(0, -5)); return [{ id: d.id, name: d.name, source: d.source, createdAt: d.createdAt, count: d.rows.length, staxVerified: false }]; } catch { return []; } });
}

/** Imported data never supplies shell commands. Trials start in an empty disposable repository. */
export function datasetTasks(id: string) {
  const dataset = readDataset(id);
  if (dataset.rows.some((row) => row.expectedOutput === undefined && !row.rubric)) throw new Error("Each runnable dataset row needs expectedOutput or a rubric");
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "rigwell-eval-dataset-"));
  const cleanup = () => { if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync.native(root) !== root) throw new Error("Dataset fixture ownership changed"); rmSync(root, { recursive: true, force: true }); };
  try {
    const tasks: TaskDef[] = dataset.rows.map((row, i) => {
      const dir = join(root, String(i)), fixtureDir = join(dir, "repo"); mkdirSync(fixtureDir, { recursive: true }); writeFileSync(join(fixtureDir, "README.md"), "# Disposable evaluation workspace\n");
      return { name: `dataset-${id.slice(0, 8)}-${i + 1}`, dir, fixtureDir, prompt: row.prompt, grader: "", budget: {}, ...(row.expectedOutput !== undefined ? { expectedOutput: row.expectedOutput } : {}), ...(row.rubric ? { rubric: row.rubric } : {}) };
    });
    return { tasks, cleanup };
  } catch (e) { cleanup(); throw e; }
}
