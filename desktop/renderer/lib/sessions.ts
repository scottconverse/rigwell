// Session list logic for the sidebar and Session Management (spec §14.3, §12.1). Pure functions, no DOM.
export interface SessionRow {
  id: string; title: string; cwd?: string; updatedAt: number;
  pinned?: boolean; archivedAt?: number | null; isSubagent?: boolean; hasUserVisibleMessages?: boolean;
}

const asMs = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || 0 : 0);

/** Accepts both `rigwell.list_sessions` rows and the older `daemon.list_sessions` rows. */
export function normalizeSession(r: any): SessionRow {
  const archived = r.archivedAt == null ? null : asMs(r.archivedAt) || Date.now();
  return {
    id: String(r.sessionId ?? r.id), title: String(r.title || "Untitled"), cwd: r.cwd, updatedAt: asMs(r.updatedAt),
    pinned: r.pinned === true, archivedAt: archived, isSubagent: r.isSubagent === true, hasUserVisibleMessages: r.hasUserVisibleMessages !== false,
  };
}

/** Sessions that "Archive Project" archives: the project's visible sessions that are not archived yet. */
export function projectArchiveTargets(sessions: SessionRow[], cwd: string): SessionRow[] {
  return sessions.filter((s) => s.cwd === cwd && !isArchived(s) && !s.isSubagent);
}

export const isArchived = (s: SessionRow) => s.archivedAt != null;

export interface Filter { lookbackDays?: number; project?: string; query?: string; now?: number }

/** Sidebar rows: archived and subagent sessions hidden, pinned first, then newest first. */
export function sidebarRows(sessions: SessionRow[], f: Filter = {}): SessionRow[] {
  const now = f.now ?? Date.now();
  return sessions
    .filter((s) => !isArchived(s) && !s.isSubagent && s.hasUserVisibleMessages !== false)
    .filter((s) => (f.lookbackDays ? now - s.updatedAt < f.lookbackDays * 86400_000 || s.pinned : true))
    .filter((s) => !f.project || s.cwd === f.project)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
}

export function groupByProject(rows: SessionRow[]): [string, SessionRow[]][] {
  const m = new Map<string, SessionRow[]>();
  for (const r of rows) m.set(r.cwd ?? "", [...(m.get(r.cwd ?? "") ?? []), r]);
  // A project whose first row is pinned goes first; otherwise by newest activity.
  return [...m.entries()].sort((a, b) => Number(!!b[1][0].pinned) - Number(!!a[1][0].pinned) || b[1][0].updatedAt - a[1][0].updatedAt);
}

/** Session Management table: one tab shows active, the other archived; search over title and folder. */
export function managementRows(sessions: SessionRow[], tab: "active" | "archived", f: Filter = {}): SessionRow[] {
  const q = (f.query ?? "").trim().toLowerCase();
  const now = f.now ?? Date.now();
  return sessions
    .filter((s) => !s.isSubagent && (tab === "archived") === isArchived(s))
    .filter((s) => !f.project || s.cwd === f.project)
    .filter((s) => !f.lookbackDays || now - s.updatedAt < f.lookbackDays * 86400_000)
    .filter((s) => !q || `${s.title} ${s.cwd ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Bulk rename: replaces `find` in each title; rows whose title does not change are left out. */
export function bulkRename(rows: SessionRow[], find: string, replace: string): { row: SessionRow; title: string }[] {
  if (!find) return [];
  return rows.filter((r) => r.title.includes(find)).map((r) => ({ row: r, title: r.title.split(find).join(replace).trim() })).filter((p) => p.title && p.title !== p.row.title);
}

export const projectName = (cwd?: string) => (cwd ? cwd.split("/").filter(Boolean).pop() ?? cwd : "No folder");

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export type SessionAction = "pin" | "rename" | "archive";
/** The RPC (without prefix) and params for a header or table action. */
export function actionCall(action: SessionAction, s: Pick<SessionRow, "pinned" | "archivedAt">, value?: string): { method: string; params: Record<string, unknown> } {
  if (action === "pin") return { method: "pin_session", params: { pinned: !s.pinned } };
  if (action === "archive") return { method: "archive_session", params: { archived: s.archivedAt == null } };
  const title = (value ?? "").trim();
  if (!title) throw new Error("A title cannot be empty");
  return { method: "rename_session", params: { title: title.slice(0, 200) } };
}
