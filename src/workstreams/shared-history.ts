// Version history for a Workstream's shared folder (spec 15.10). Every saved file keeps a stable id and a version number.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicJson } from "./store.ts";

export const SHARED_HISTORY_MAX_BYTES = () => Number(process.env.RIGWELL_SHARED_HISTORY_MAX_BYTES) > 0 ? Number(process.env.RIGWELL_SHARED_HISTORY_MAX_BYTES) : 20 * 1024 * 1024;

export interface SharedVersion { version: number; at: number; by: string; sha256: string; bytes: number; mtimeMs: number; stored: boolean; deleted?: true }
export interface SharedDoc { id: string; versions: SharedVersion[] }
export interface SharedIndex { docs: Record<string, SharedDoc> }

const PATH_ERROR = "Path must stay inside the shared folder";
const activeWrites = new Map<string, number>();

/** Marks a tool that may write the shared folder, so a listing during its run does not sweep its files. */
export function beginSharedWrite(sharedRoot: string) {
  const key = resolve(sharedRoot);
  activeWrites.set(key, (activeWrites.get(key) ?? 0) + 1);
}
export function endSharedWrite(sharedRoot: string) {
  const key = resolve(sharedRoot), count = (activeWrites.get(key) ?? 0) - 1;
  if (count > 0) activeWrites.set(key, count); else activeWrites.delete(key);
}
export function sharedWritesActive(sharedRoot: string): boolean {
  return (activeWrites.get(resolve(sharedRoot)) ?? 0) > 0;
}
const MAX_WALK_FILES = 2000;
const MAX_TEXT_BYTES = 1024 * 1024;

const realTarget = (path: string): string => {
  try { lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return dirname(path) === path ? path : join(realTarget(dirname(path)), basename(path));
  }
  return realpathSync(path);
};
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); };
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const historyDir = (sharedRoot: string) => join(dirname(sharedRoot), "shared-history");
const indexPath = (sharedRoot: string) => join(historyDir(sharedRoot), "index.json");
const blobPath = (sharedRoot: string, sha: string) => join(historyDir(sharedRoot), "blobs", sha);
const toKey = (path: string) => path.split(sep).join("/");

function readIndex(sharedRoot: string): SharedIndex {
  try {
    const raw = JSON.parse(readFileSync(indexPath(sharedRoot), "utf8"));
    return { docs: raw && typeof raw.docs === "object" && raw.docs ? raw.docs as Record<string, SharedDoc> : {} };
  } catch { return { docs: {} }; }
}
function writeIndex(sharedRoot: string, index: SharedIndex) {
  mkdirSync(historyDir(sharedRoot), { recursive: true, mode: 0o700 });
  atomicJson(indexPath(sharedRoot), index);
}
function storeBlob(sharedRoot: string, sha: string, buf: Buffer) {
  const file = blobPath(sharedRoot, sha);
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, buf, { mode: 0o600 });
}
function addVersion(index: SharedIndex, key: string, entry: Omit<SharedVersion, "version">): SharedVersion {
  const doc = index.docs[key] ?? (index.docs[key] = { id: crypto.randomUUID(), versions: [] });
  const record: SharedVersion = { version: (doc.versions.at(-1)?.version ?? 0) + 1, ...entry };
  doc.versions.push(record);
  return record;
}
/** Relative key for the functions that take a path from a caller. Absolute and escaping paths are refused. */
function sharedKey(sharedRoot: string, path: string): string {
  const root = resolve(sharedRoot);
  if (typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) throw new Error(PATH_ERROR);
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(PATH_ERROR);
  return toKey(rel);
}
function walkFiles(root: string): string[] {
  const out: string[] = [], stack = [root];
  while (stack.length && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()!;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) { out.push(full); if (out.length >= MAX_WALK_FILES) break; }
    }
  }
  return out;
}

/** Records one file. Returns null when the path is outside the shared folder. */
export function recordSharedPath(sharedRoot: string, absPath: string, by: string): { path: string; id: string; version: number } | null {
  const root = resolve(sharedRoot), target = resolve(absPath);
  if (!inside(root, target)) return null;
  let realRoot: string, realFile: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  try { realFile = realTarget(target); } catch { return null; }
  if (!inside(realRoot, realFile)) return null;
  const key = toKey(relative(root, target));
  if (!key || key.startsWith("..") || isAbsolute(key)) return null;
  const index = readIndex(root), doc = index.docs[key], latest = doc?.versions.at(-1);
  let st: ReturnType<typeof statSync> | undefined;
  try { st = statSync(target); } catch { st = undefined; }
  if (st?.isFile()) {
    const buf = readFileSync(target), digest = sha256(buf);
    if (latest && !latest.deleted && latest.sha256 === digest) return { path: key, id: doc!.id, version: latest.version };
    const stored = buf.length <= SHARED_HISTORY_MAX_BYTES();
    if (stored) storeBlob(root, digest, buf);
    const record = addVersion(index, key, { at: Date.now(), by, sha256: digest, bytes: buf.length, mtimeMs: st.mtimeMs, stored });
    writeIndex(root, index);
    return { path: key, id: index.docs[key]!.id, version: record.version };
  }
  if (latest && !latest.deleted) {
    const record = addVersion(index, key, { at: Date.now(), by, sha256: "", bytes: 0, mtimeMs: 0, stored: false, deleted: true });
    writeIndex(root, index);
    return { path: key, id: index.docs[key]!.id, version: record.version };
  }
  if (latest) return { path: key, id: doc!.id, version: latest.version };
  return null;
}

/** Walks the shared folder and records what changed. Returns how many versions were added. */
export function recordSharedFolder(sharedRoot: string, by: string): number {
  const root = resolve(sharedRoot);
  const firstRun = !existsSync(indexPath(root));
  const index = readIndex(root);
  let added = 0;
  const seen = new Set<string>();
  for (const file of walkFiles(root)) {
    const key = toKey(relative(root, file));
    seen.add(key);
    let st; try { st = statSync(file); } catch { continue; }
    const latest = index.docs[key]?.versions.at(-1);
    if (latest && !latest.deleted && latest.mtimeMs === st.mtimeMs && latest.bytes === st.size) continue;
    let buf: Buffer; try { buf = readFileSync(file); } catch { continue; }
    const digest = sha256(buf);
    if (latest && !latest.deleted && latest.sha256 === digest) continue;
    const stored = buf.length <= SHARED_HISTORY_MAX_BYTES();
    if (stored) storeBlob(root, digest, buf);
    addVersion(index, key, { at: Date.now(), by: firstRun ? "existing file" : by, sha256: digest, bytes: buf.length, mtimeMs: st.mtimeMs, stored });
    added++;
  }
  for (const [key, doc] of Object.entries(index.docs)) {
    if (seen.has(key) || existsSync(join(root, key))) continue;
    const latest = doc.versions.at(-1);
    if (!latest || latest.deleted) continue;
    addVersion(index, key, { at: Date.now(), by: firstRun ? "existing file" : by, sha256: "", bytes: 0, mtimeMs: 0, stored: false, deleted: true });
    added++;
  }
  if (added || firstRun) writeIndex(root, index);
  return added;
}

export function listSharedDocs(sharedRoot: string): { path: string; id: string; version: number; at: number; by: string; deleted: boolean }[] {
  const rows = Object.entries(readIndex(resolve(sharedRoot)).docs).flatMap(([path, doc]) => {
    const latest = doc.versions.at(-1);
    if (!latest) return [];
    return [{ path, id: doc.id, version: latest.version, at: latest.at, by: latest.by, deleted: latest.deleted === true }];
  });
  return rows.sort((a, b) => b.at - a.at);
}

export function sharedHistory(sharedRoot: string, path: string): { path: string; id: string; versions: SharedVersion[] } {
  const root = resolve(sharedRoot), key = sharedKey(root, path);
  const doc = readIndex(root).docs[key];
  if (!doc) throw new Error("Unknown shared file");
  return { path: key, id: doc.id, versions: [...doc.versions].reverse() };
}

export function readSharedVersion(sharedRoot: string, path: string, version: number): { stored: boolean; content?: string; base64?: string; tooLarge?: true; bytes: number } {
  const root = resolve(sharedRoot), key = sharedKey(root, path);
  const doc = readIndex(root).docs[key];
  if (!doc) throw new Error("Unknown shared file");
  const entry = doc.versions.find((v) => v.version === version);
  if (!entry) throw new Error("Unknown shared version");
  if (!entry.stored) return { stored: false, bytes: entry.bytes };
  if (entry.bytes > MAX_TEXT_BYTES) return { stored: true, tooLarge: true, bytes: entry.bytes };
  let buf: Buffer;
  try { buf = readFileSync(blobPath(root, entry.sha256)); } catch { throw new Error("Stored version copy is missing"); }
  const binary = buf.subarray(0, 8000).includes(0);
  return binary ? { stored: true, base64: buf.toString("base64"), bytes: entry.bytes } : { stored: true, content: buf.toString("utf8"), bytes: entry.bytes };
}

export function restoreSharedVersion(sharedRoot: string, path: string, version: number, by = "user"): { path: string; id: string; version: number } | null {
  const root = resolve(sharedRoot), key = sharedKey(root, path);
  const doc = readIndex(root).docs[key];
  if (!doc) throw new Error("Unknown shared file");
  const entry = doc.versions.find((v) => v.version === version);
  if (!entry) throw new Error("Unknown shared version");
  if (entry.deleted) throw new Error("A deleted version cannot be restored");
  if (!entry.stored) throw new Error("This version has no saved copy");
  const target = join(root, key);
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  if (!inside(realRoot, realTarget(dirname(target)))) throw new Error(PATH_ERROR);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const buf = readFileSync(blobPath(root, entry.sha256));
  writeFileSync(target, buf, { mode: 0o600 });
  return recordSharedPath(root, target, `${by} (restored version ${version})`);
}
