// Session picker data (spec 12.1 "Picker"): rows for list_sessions, resume pickers and the desktop sidebar.
// Subagent sessions and sessions without a user-visible message are hidden; archived ones only on request.
import { readFileSync, statSync } from "node:fs";
import { listSessions } from "./transcript.ts";
import { readSessionSettings } from "./session-settings.ts";

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

/** Side-chat forks (tag btw-fork, spec 17.4) are hidden unless `includeBtwForks` is set. */
export function listSessionEntries(o: { cwd?: string; includeArchived?: boolean; includeBtwForks?: boolean; limit?: number } = {}): SessionListEntry[] {
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
    if (!o.includeBtwForks && tags.some((t) => t?.name === "btw-fork")) continue;
    if (archivedAt && !o.includeArchived) continue;
    rows.push({
      sessionId: s.id, title: displayTitle(typeof settings.title === "string" && settings.title ? settings.title : s.title, first), cwd: s.cwd ?? "",
      updatedAt: new Date(s.mtimeMs).toISOString(), pinned: settings.pinned === true, archivedAt, isSubagent, hasUserVisibleMessages: visible,
    });
  }
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return o.limit && o.limit > 0 ? rows.slice(0, o.limit) : rows;
}
