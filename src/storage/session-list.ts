// Session picker data (spec 12.1 "Picker"): rows for list_sessions, resume pickers and the desktop sidebar.
// Subagent sessions and sessions without a user-visible message are hidden; archived ones only on request.
import { readFileSync, statSync } from "node:fs";
import { listSessions } from "./transcript.ts";
import { readSessionSettings } from "./session-settings.ts";
import { indexDbPath, openSessionIndex, queryPicker, refreshIndex } from "./session-index.ts";
import { projectSlug } from "./paths.ts";
import type { Database } from "bun:sqlite";

export interface SessionListEntry {
  sessionId: string;
  title: string;
  cwd: string;
  /** ISO time of the last write. */
  updatedAt: string;
  pinned: boolean;
  archivedAt: string | null;
  isSubagent: boolean;
  hasUserVisibleMessages: boolean;
}

const visibleCache = new Map<string, { mtimeMs: number; value: boolean; first: string }>();

/** True when the transcript holds a user message the UI shows (not llm_only context or reminders); `first` is its text. */
function firstVisibleUserMessage(file: string, mtimeMs: number): { value: boolean; first: string } {
  const hit = visibleCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let value = false;
  let first = "";
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      const o = JSON.parse(line);
      const m = o?.message;
      if (m?.role === "user" && m.visibility !== "llm_only" && m.visibility !== "user_only" && !String(o.id).startsWith("context-")) {
        value = true;
        first = (Array.isArray(m.content) ? m.content.find((b: any) => b?.type === "text")?.text : "") ?? "";
        break;
      }
    }
  } catch { /* unreadable: not visible */ }
  visibleCache.set(file, { mtimeMs, value, first });
  return { value, first };
}

/** An untitled session shows the start of its first message. */
function displayTitle(title: string, first: string): string {
  if (title !== "New Session" || !first.trim()) return title;
  const one = first.trim().replace(/\s+/g, " ");
  return one.length > 80 ? one.slice(0, 79) + "..." : one;
}

const indexes = new Map<string, Database>();

/** Rows from the SQLite index (spec 12.1 picker). Throws when the index cannot be used. */
function listFromIndex(o: { cwd?: string; includeArchived?: boolean; limit?: number }): SessionListEntry[] {
  const file = indexDbPath();
  let db = indexes.get(file);
  if (!db) { db = openSessionIndex(file); indexes.set(file, db); }
  try {
    refreshIndex(db, o.cwd ? projectSlug(o.cwd) : undefined);
    return queryPicker(db, o).map((r) => ({
      sessionId: r.sessionId, title: displayTitle(r.title, r.preview), cwd: r.cwd, updatedAt: new Date(r.lastEventAt).toISOString(), pinned: r.pinned,
      archivedAt: r.archivedAt, isSubagent: false, hasUserVisibleMessages: true,
    }));
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    indexes.delete(file);
    throw e;
  }
}

/** Closes cached index handles (tests that delete the home folder). */
export function closeSessionIndexes() {
  for (const db of indexes.values()) { try { db.close(); } catch { /* ignore */ } }
  indexes.clear();
}

export function listSessionEntries(o: { cwd?: string; includeArchived?: boolean; limit?: number } = {}): SessionListEntry[] {
  try {
    return listFromIndex(o);
  } catch (e) {
    if (process.env.RIGWELL_DEBUG) console.error(`[session-index] falling back to the file scan: ${(e as Error)?.message ?? e}`);
    return scanSessionEntries(o);
  }
}

/** The file scan: reads every transcript and settings file. The fallback when the index is unusable. */
export function scanSessionEntries(o: { cwd?: string; includeArchived?: boolean; limit?: number } = {}): SessionListEntry[] {
  const rows: SessionListEntry[] = [];
  for (const s of listSessions(o.cwd)) {
    const settings = readSessionSettings({ settingsPath: s.transcriptPath.replace(/\.jsonl$/, ".settings.json") }) ?? {};
    const tags = Array.isArray(settings.tags) ? settings.tags : [];
    const isSubagent = tags.some((t) => t?.name === "subagent");
    const archivedAt = typeof settings.archivedAt === "string" ? settings.archivedAt : null;
    let mtimeMs = s.mtimeMs;
    try { mtimeMs = statSync(s.transcriptPath).mtimeMs; } catch { /* keep */ }
    const { value: visible, first } = firstVisibleUserMessage(s.transcriptPath, mtimeMs);
    if (isSubagent || !visible) continue;
    if (archivedAt && !o.includeArchived) continue;
    rows.push({
      sessionId: s.id, title: displayTitle(typeof settings.title === "string" && settings.title ? settings.title : s.title, first), cwd: s.cwd ?? "",
      updatedAt: new Date(s.mtimeMs).toISOString(), pinned: settings.pinned === true, archivedAt, isSubagent, hasUserVisibleMessages: visible,
    });
  }
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return o.limit && o.limit > 0 ? rows.slice(0, o.limit) : rows;
}
