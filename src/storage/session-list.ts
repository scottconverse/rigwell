// Session picker data (spec 12.1 "Picker"): rows for list_sessions, resume pickers and the desktop sidebar.
// Subagent sessions and sessions without a user-visible message are hidden; archived ones only on request.
import { readFileSync, statSync } from "node:fs";
import { listSessions } from "./transcript.ts";
import { readSessionSettings } from "./session-settings.ts";

export interface SessionListEntry {
  sessionId: string;
  title: string;
  cwd: string;
  /** Epoch seconds of the last write. */
  updatedAt: number;
  pinned: boolean;
  archivedAt: string | null;
  isSubagent: boolean;
  hasUserVisibleMessages: boolean;
}

const visibleCache = new Map<string, { mtimeMs: number; value: boolean }>();

/** True when the transcript holds a user message the UI shows (not llm_only context or reminders). */
function hasVisibleUserMessage(file: string, mtimeMs: number): boolean {
  const hit = visibleCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  let value = false;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"type":"message"')) continue;
      const o = JSON.parse(line);
      const m = o?.message;
      if (m?.role === "user" && m.visibility !== "llm_only" && m.visibility !== "user_only" && !String(o.id).startsWith("context-")) { value = true; break; }
    }
  } catch { /* unreadable: not visible */ }
  visibleCache.set(file, { mtimeMs, value });
  return value;
}

export function listSessionEntries(o: { cwd?: string; includeArchived?: boolean; limit?: number } = {}): SessionListEntry[] {
  const rows: SessionListEntry[] = [];
  for (const s of listSessions(o.cwd)) {
    const settings = readSessionSettings({ settingsPath: s.transcriptPath.replace(/\.jsonl$/, ".settings.json") }) ?? {};
    const tags = Array.isArray(settings.tags) ? settings.tags : [];
    const isSubagent = tags.some((t) => t?.name === "subagent");
    const archivedAt = typeof settings.archivedAt === "string" ? settings.archivedAt : null;
    let mtimeMs = s.mtimeMs;
    try { mtimeMs = statSync(s.transcriptPath).mtimeMs; } catch { /* keep */ }
    const visible = hasVisibleUserMessage(s.transcriptPath, mtimeMs);
    if (isSubagent || !visible) continue;
    if (archivedAt && !o.includeArchived) continue;
    rows.push({
      sessionId: s.id, title: typeof settings.title === "string" && settings.title ? settings.title : s.title, cwd: s.cwd ?? "",
      updatedAt: Math.floor(s.mtimeMs / 1000), pinned: settings.pinned === true, archivedAt, isSubagent, hasUserVisibleMessages: visible,
    });
  }
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return o.limit && o.limit > 0 ? rows.slice(0, o.limit) : rows;
}
