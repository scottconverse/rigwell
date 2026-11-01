// File snapshots and session rewind (spec 12.1, 13.2 /rewind-conversation).
//
// Capture: Edit and Create call `before(abs)` ahead of a write. The first time a path is touched inside a
// boundary (one boundary per user message) its previous bytes go to the content store, or the path is
// listed under `creations` when it did not exist. `after(abs)` records the hash the agent left behind so a
// later rewind can tell whether someone else changed the file since (the stale check).
//
// Rewind to user message M: the model-visible transcript ends at M (a `rewind` record is appended; no transcript
// line is deleted), and with restoreFiles every file touched at or after M's boundary goes back to the content it
// had when M was sent (created files are removed).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message, ToolContext } from "../core/types.ts";
import { appendRewind, findSession, loadTranscript } from "../storage/transcript.ts";
import {
  type Boundary, type Manifest, MAX_FILE_BYTES, evict, getContent, hasContent, hashBytes, loadIndex, loadManifest,
  putContent, saveIndex, saveManifest, sweepContent, syncIndexEntry,
} from "./store.ts";

export * from "./store.ts";

export type RewindErrorCode = "busy" | "not_found" | "not_a_prompt" | "transcript_only" | "stale" | "evicted" | "missing_content";

export class RewindError extends Error {
  constructor(public code: RewindErrorCode, message: string, public files?: string[]) {
    super(message);
  }
}

/** Hash of the file's current bytes; null when it does not exist (or is not a regular file). */
function currentHash(abs: string): string | null {
  try {
    if (!statSync(abs).isFile()) return null;
    return hashBytes(readFileSync(abs));
  } catch {
    return null;
  }
}

export class SnapshotRecorder {
  constructor(private sessionId: string, private log?: (s: string) => void) {}

  hooks(messageId: string, messageIndex: number, toolCallId: string): NonNullable<ToolContext["snapshots"]> {
    return {
      before: (abs) => {
        try { this.before(abs, messageId, messageIndex, toolCallId, "modify"); } catch (e) { this.log?.(`[snapshots] before ${abs}: ${(e as Error).message}`); }
      },
      after: (abs) => {
        try { this.after(abs); } catch (e) { this.log?.(`[snapshots] after ${abs}: ${(e as Error).message}`); }
      },
    };
  }

  /** Captures `abs` before the agent changes (or, with mode "delete", removes) it. */
  before(abs: string, messageId: string, messageIndex: number, toolCallId: string, mode: "modify" | "delete") {
    const m = loadManifest(this.sessionId);
    let at = -1;
    for (let i = m.boundaries.length - 1; i >= 0; i--) if (m.boundaries[i]!.messageId === messageId) { at = i; break; }
    if (at < 0) {
      m.boundaries.push({ messageId, messageIndex, timestamp: Date.now(), files: [], deletions: [], creations: [], totalSize: 0 });
      at = m.boundaries.length - 1;
    }
    const b = m.boundaries[at]!;
    if (b.creations.includes(abs) || b.files.some((f) => f.filePath === abs)) return; // first touch in a boundary wins
    let size = -1;
    try {
      const st = statSync(abs);
      if (st.isFile()) size = st.size;
    } catch { /* absent */ }
    if (size < 0) {
      b.creations.push(abs);
    } else {
      if (size > MAX_FILE_BYTES) { this.log?.(`[snapshots] ${abs} is ${size} bytes; not captured`); return; }
      const bytes = readFileSync(abs);
      const contentHash = putContent(bytes);
      b.files.push({ filePath: abs, contentHash, size: bytes.length, capturedAt: Date.now(), toolCallId, mode });
      if (mode === "delete") b.deletions.push(abs);
      b.totalSize += bytes.length;
      // Remember the state we found, so the stale check still works if this is the only write we see.
      if (!(abs in m.lastWrites)) m.lastWrites[abs] = contentHash;
    }
    saveManifest(m);
    const idx = loadIndex();
    syncIndexEntry(idx, m, at);
    evict(idx, undefined, { sessionId: m.sessionId, boundaryIndex: m.evictedBoundaryCount + at });
    saveIndex(idx);
  }

  /** Records the hash the agent just wrote (null when it removed the file). */
  after(abs: string) {
    const m = loadManifest(this.sessionId);
    m.lastWrites[abs] = currentHash(abs);
    saveManifest(m);
  }
}

// ---------- rewind ----------

export interface RewindTarget {
  id: string;
  cwd: string;
  isRunning: boolean;
  messages: Message[];
  archived: Message[];
  builder?: { monitor: { expectBreak(cause: string): void } };
}

export interface RewindOptions {
  session: RewindTarget;
  messageId: string;
  restoreFiles?: boolean;
  /** Restore even files that changed outside the agent since it last wrote them. */
  force?: boolean;
}

const SYNTHETIC_ID = /^(context|notice|deferred)-/;

const isPrompt = (m: Message) => m.role === "user" && !m.visibility && !SYNTHETIC_ID.test(m.id) && m.content.some((b) => b.type === "text");

type Action = { path: string; kind: "restore"; hash: string } | { path: string; kind: "remove" };

function planRestore(m: Manifest, order: Map<string, number>, from: number): { actions: Action[]; boundaries: Boundary[] } {
  const hit = m.boundaries.filter((b) => (order.get(b.messageId) ?? -1) >= from);
  const seen = new Set<string>();
  const actions: Action[] = [];
  for (const b of hit) {
    for (const f of b.files) {
      if (seen.has(f.filePath)) continue;
      seen.add(f.filePath);
      actions.push({ path: f.filePath, kind: "restore", hash: f.contentHash });
    }
    for (const c of b.creations) {
      if (seen.has(c)) continue;
      seen.add(c);
      actions.push({ path: c, kind: "remove" });
    }
  }
  return { actions, boundaries: hit };
}

export async function rewindSession(o: RewindOptions): Promise<{ removedCount: number; restoredFiles: string[] }> {
  const s = o.session;
  if (s.isRunning) throw new RewindError("busy", "A turn is running; stop it before rewinding.");
  const at = s.messages.findIndex((m) => m.id === o.messageId);
  if (at < 0) {
    if (s.archived.some((m) => m.id === o.messageId)) {
      throw new RewindError("transcript_only", "That message was summarized by a compaction; it exists only in the transcript, so the conversation cannot be rewound to it.");
    }
    throw new RewindError("not_found", `No such message in the current conversation: ${o.messageId}`);
  }
  if (!isPrompt(s.messages[at]!)) throw new RewindError("not_a_prompt", "Rewind targets a user prompt.");
  const files = findSession(s.id, s.cwd);
  if (!files) throw new RewindError("not_found", `Session transcript not found: ${s.id}`);
  const loaded = loadTranscript(files);
  const order = new Map(loaded.allMessageIds.map((id, i) => [id, i] as const));
  const from = order.get(o.messageId);
  if (from === undefined) throw new RewindError("not_found", "The message is not in the transcript.");

  const restored: string[] = [];
  if (o.restoreFiles) {
    const m = loadManifest(s.id);
    const evictedAt = m.evictedThroughMessageId !== undefined ? order.get(m.evictedThroughMessageId) : undefined;
    if (evictedAt !== undefined && from <= evictedAt) {
      throw new RewindError("evicted", "File snapshots for that point were evicted to save space; rewind without restoring files, or to a later message.");
    }
    const { actions, boundaries } = planRestore(m, order, from);
    const missing = actions.filter((a) => a.kind === "restore" && !hasContent(a.hash)).map((a) => a.path);
    if (missing.length) throw new RewindError("missing_content", `Snapshot content is missing for: ${missing.join(", ")}`, missing);
    if (!o.force) {
      const stale = actions.filter((a) => {
        const expected = m.lastWrites[a.path];
        return expected !== undefined && currentHash(a.path) !== expected;
      }).map((a) => a.path);
      if (stale.length) {
        throw new RewindError("stale", `These files changed outside the agent since its last edit: ${stale.join(", ")}. Nothing was changed. Rewind again with force to overwrite them.`, stale);
      }
    }
    for (const a of actions) {
      if (a.kind === "restore") {
        mkdirSync(path.dirname(a.path), { recursive: true });
        writeFileSync(a.path, getContent(a.hash));
        m.lastWrites[a.path] = a.hash;
      } else {
        rmSync(a.path, { force: true });
        m.lastWrites[a.path] = null;
      }
      restored.push(a.path);
    }
    // The restored boundaries are history now: their files are back to the state they recorded.
    const gone = new Set(boundaries);
    const keep = m.boundaries.filter((b) => !gone.has(b));
    const idx = loadIndex();
    const dropped: string[] = [];
    const firstGone = m.evictedBoundaryCount + keep.length;
    idx.boundaryQueue = idx.boundaryQueue.filter((e) => {
      const drop = e.sessionId === m.sessionId && e.boundaryIndex >= firstGone;
      if (drop) dropped.push(...e.contentHashes);
      return !drop;
    });
    m.boundaries = keep;
    saveManifest(m);
    saveIndex(idx);
    sweepContent(idx, dropped);
  }

  const removed = s.messages.length - (at + 1);
  await appendRewind(files, { messageId: o.messageId, removedCount: removed, restoredFiles: restored });
  s.messages.length = at + 1; // in place: the request builder keeps a reference
  s.builder?.monitor.expectBreak("rewind");
  return { removedCount: removed, restoredFiles: restored };
}
