// File snapshot store (spec 12.1 "Other per-session state outside sessions/"):
//   $RIGWELL_HOME/snapshots/manifests/<sessionId>.snapshots.json   rewind points, one boundary per user message
//   $RIGWELL_HOME/snapshots/content/<2 hex>/<rest of sha256>        file bytes by hash
//   $RIGWELL_HOME/snapshots/.index.json                             eviction queue
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rigwellHome, validateSessionId } from "../storage/paths.ts";

export interface SnapshotFile {
  filePath: string;
  contentHash: string;
  size: number;
  capturedAt: number;
  toolCallId: string;
  /** "modify": content before an edit or overwrite. "delete": content of a file the agent removed. */
  mode: "modify" | "delete";
}

export interface Boundary {
  messageId: string;
  messageIndex: number;
  timestamp: number;
  files: SnapshotFile[];
  /** Paths removed by the agent during this boundary (content is in `files` with mode "delete"). */
  deletions: string[];
  /** Paths created by the agent during this boundary (rewind removes them). */
  creations: string[];
  totalSize: number;
}

export interface Manifest {
  sessionId: string;
  version: 1;
  createdAt: number;
  lastAccessedAt: number;
  boundaries: Boundary[];
  oldestAvailableBoundaryIndex: number;
  evictedBoundaryCount: number;
  /** Rigwell extra: id of the newest evicted boundary's message; rewinding to or before it cannot restore files. */
  evictedThroughMessageId?: string;
  /** Rigwell extra: hash of each path right after the agent last wrote it (null: absent). Used by the stale check. */
  lastWrites: Record<string, string | null>;
}

export interface IndexEntry {
  sessionId: string;
  boundaryIndex: number;
  timestamp: number;
  sizeBytes: number;
  contentHashes: string[];
}

export interface SnapshotIndex {
  version: 1;
  lastCleanupAt: number;
  totalSizeBytes: number;
  boundaryQueue: IndexEntry[];
}

/** Total stored bytes (sum of boundary sizes) above which the oldest boundaries are evicted. Env RIGWELL_SNAPSHOT_MAX_BYTES overrides. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Files larger than this are not snapshotted (rewind cannot restore them). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const maxBytes = () => {
  const n = Number(process.env.RIGWELL_SNAPSHOT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
};

export const snapshotsDir = () => path.join(rigwellHome(), "snapshots");
const manifestPath = (id: string) => {
  validateSessionId(id);
  return path.join(snapshotsDir(), "manifests", `${id}.snapshots.json`);
};
const indexPath = () => path.join(snapshotsDir(), ".index.json");
export const contentPath = (hash: string) => path.join(snapshotsDir(), "content", hash.slice(0, 2), hash.slice(2));

export const hashBytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function writeJson(file: string, v: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Stores bytes by hash (idempotent). Returns the hash. */
export function putContent(bytes: Uint8Array): string {
  const h = hashBytes(bytes);
  const p = contentPath(h);
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
  }
  return h;
}

export const getContent = (hash: string): Buffer => readFileSync(contentPath(hash));
export const hasContent = (hash: string) => existsSync(contentPath(hash));

export function loadManifest(sessionId: string): Manifest {
  const m = readJson<Manifest>(manifestPath(sessionId));
  if (m && Array.isArray(m.boundaries)) {
    m.lastWrites ??= {};
    return m;
  }
  const now = Date.now();
  return { sessionId, version: 1, createdAt: now, lastAccessedAt: now, boundaries: [], oldestAvailableBoundaryIndex: 0, evictedBoundaryCount: 0, lastWrites: {} };
}

export function saveManifest(m: Manifest) {
  m.lastAccessedAt = Date.now();
  m.oldestAvailableBoundaryIndex = m.evictedBoundaryCount;
  writeJson(manifestPath(m.sessionId), m);
}

export function loadIndex(): SnapshotIndex {
  const i = readJson<SnapshotIndex>(indexPath());
  if (i && Array.isArray(i.boundaryQueue)) return i;
  return { version: 1, lastCleanupAt: Date.now(), totalSizeBytes: 0, boundaryQueue: [] };
}

export function saveIndex(i: SnapshotIndex) {
  i.totalSizeBytes = i.boundaryQueue.reduce((n, e) => n + e.sizeBytes, 0);
  writeJson(indexPath(), i);
}

/** Rebuilds the queue entry of one boundary (absolute index = evictedBoundaryCount + array position). */
export function syncIndexEntry(idx: SnapshotIndex, m: Manifest, pos: number) {
  const b = m.boundaries[pos]!;
  const boundaryIndex = m.evictedBoundaryCount + pos;
  const entry: IndexEntry = {
    sessionId: m.sessionId, boundaryIndex, timestamp: b.timestamp, sizeBytes: b.totalSize,
    contentHashes: [...new Set(b.files.map((f) => f.contentHash))],
  };
  const at = idx.boundaryQueue.findIndex((e) => e.sessionId === m.sessionId && e.boundaryIndex === boundaryIndex);
  if (at >= 0) idx.boundaryQueue[at] = entry;
  else idx.boundaryQueue.push(entry);
}

/** Deletes blobs that no queue entry references any more. */
export function sweepContent(idx: SnapshotIndex, candidates: Iterable<string>) {
  const live = new Set(idx.boundaryQueue.flatMap((e) => e.contentHashes));
  for (const h of new Set(candidates)) if (!live.has(h)) rmSync(contentPath(h), { force: true });
}

/**
 * Evicts the oldest boundaries (any session) until the stored size is within the cap.
 * The boundary being written is never evicted. Returns the number evicted.
 */
export function evict(idx: SnapshotIndex, cap = maxBytes(), keep?: { sessionId: string; boundaryIndex: number }): number {
  let n = 0;
  const dropped: string[] = [];
  for (;;) {
    const total = idx.boundaryQueue.reduce((s, e) => s + e.sizeBytes, 0);
    if (total <= cap) break;
    idx.boundaryQueue.sort((a, b) => a.timestamp - b.timestamp || a.boundaryIndex - b.boundaryIndex);
    const at = idx.boundaryQueue.findIndex((e) => !(keep && e.sessionId === keep.sessionId && e.boundaryIndex === keep.boundaryIndex));
    if (at < 0) break;
    const [victim] = idx.boundaryQueue.splice(at, 1);
    dropped.push(...victim!.contentHashes);
    const m = loadManifest(victim!.sessionId);
    const pos = victim!.boundaryIndex - m.evictedBoundaryCount;
    // Boundaries of one session leave oldest first, so the victim is the first array element.
    if (pos === 0 && m.boundaries.length) {
      const [b] = m.boundaries.splice(0, 1);
      m.evictedBoundaryCount++;
      m.evictedThroughMessageId = b!.messageId;
      saveManifest(m);
    }
    n++;
  }
  if (n) {
    idx.lastCleanupAt = Date.now();
    sweepContent(idx, dropped);
  }
  return n;
}
