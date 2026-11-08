// Pure helpers for the /sessions grouping and the /tree view: forks sit under the session they were copied from.

export interface SessionRow { id: string; title?: string; updatedAt?: string; pinned?: boolean; parent?: string }
export interface TreeRow { row: SessionRow; depth: number }

/**
 * Orders rows so every fork follows its parent (indented by depth). Rows keep the given order among siblings.
 * A row whose parent is not in the list (or an old session without one) is shown at the top level.
 */
export function groupSessions(rows: SessionRow[]): TreeRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, SessionRow[]>();
  const tops: SessionRow[] = [];
  for (const r of rows) {
    if (r.parent && r.parent !== r.id && ids.has(r.parent)) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
    else tops.push(r);
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (r: SessionRow, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ row: r, depth });
    for (const k of kids.get(r.id) ?? []) walk(k, depth + 1);
  };
  for (const r of tops) walk(r, 0);
  for (const r of rows) walk(r, 0); // parent cycles: nothing is dropped
  return out;
}

/** The family of `currentId`: its root, the root's forks, and their forks, as an indented list. Empty when the id is unknown. */
export function familyTree(rows: SessionRow[], currentId: string | undefined): TreeRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!currentId || !byId.has(currentId)) return [];
  let root = currentId;
  const guard = new Set<string>([root]);
  for (let p = byId.get(root)?.parent; p && byId.has(p) && !guard.has(p); p = byId.get(p)?.parent) { root = p; guard.add(p); }
  const family = new Set<string>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!family.has(r.id) && r.parent && family.has(r.parent)) { family.add(r.id); grew = true; }
  }
  return groupSessions(rows.filter((r) => family.has(r.id)));
}

/** One picker line: indent by depth, short id, pin mark, title, time. */
export function sessionLabel(t: TreeRow, currentId?: string): string {
  const { row: x, depth } = t;
  const indent = depth ? "  ".repeat(depth - 1) + "└ " : "";
  const mark = x.id === currentId ? " (current)" : "";
  return `${indent}${x.id.slice(0, 8)}  ${x.pinned ? "* " : ""}${x.title ?? "(untitled)"}${x.updatedAt ? "  " + x.updatedAt.slice(0, 16).replace("T", " ") : ""}${mark}`;
}
