// Local session index (spec 12.1 "Local search index"): a rebuildable SQLite cache of the transcripts that feeds the picker.
// The .jsonl and .settings.json files stay the source of truth. Migrations are .sql files with a checksum ledger.
// Spans, bloom filters and vectors (search) are not built.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectSlug, rigwellHome, sessionsDir } from "./paths.ts";

export const INGEST_SCHEMA_VERSION = 1;

export class SessionIndexError extends Error {}

export function indexDbPath(): string {
  return path.join(rigwellHome(), "cache", "session-index", "index.db");
}

const MIGRATIONS_DIR = path.join(import.meta.dir, "migrations");

export interface Migration { version: number; name: string; sql: string; checksum: string }

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(dir, f), "utf8");
      return { version: Number(f.split("_")[0]), name: f.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

/** Applies every migration not yet in the ledger; a changed checksum throws. */
export function migrate(db: Database, migrations = loadMigrations()): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Map<number, { checksum: string }>();
  for (const r of db.query("SELECT version, checksum FROM schema_migrations").all() as { version: number; checksum: string }[]) applied.set(r.version, r);
  for (const m of migrations) {
    const have = applied.get(m.version);
    if (have) {
      if (have.checksum !== m.checksum) throw new SessionIndexError(`migration ${m.name} changed since it was applied (checksum mismatch); delete the index to rebuild it`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(m.version, m.name, m.checksum, Date.now());
    })();
  }
}

/** Opens (and migrates) the index. Throws when the file is unusable; the caller falls back to the file scan. */
export function openSessionIndex(file = indexDbPath()): Database {
  mkdirSync(path.dirname(file), { recursive: true });
  const marker = path.join(path.dirname(file), ".metadata_never_index");
  if (!existsSync(marker)) writeFileSync(marker, "");
  const db = new Database(file, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Deletes the cache files so the next open rebuilds from the transcripts. */
export function resetSessionIndex(file = indexDbPath()): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}

// ---------- ingest ----------

interface Row {
  session_id: string; project_key: string; cwd: string | null; title: string | null; owner: string | null; parent: string | null;
  calling_session_id: string | null; calling_tool_use_id: string | null; mission: string | null; tags: string;
  has_user_visible_messages: number | null; archived_at: string | null; first_event_at: number | null; last_event_at: number | null;
  messages_count: number; host_id: string | null; worktree: string | null; pinned: number; preview: string; transcript_path: string;
}

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const stamp = (s: unknown): number | null => {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** A user message the UI shows (not llm_only context or reminders). */
function visibleUser(o: any): boolean {
  const m = o?.message;
  return m?.role === "user" && m.visibility !== "llm_only" && m.visibility !== "user_only" && !String(o.id ?? "").startsWith("context-");
}

function settingsOf(file: string): Record<string, any> | null {
  for (const f of [file, file + ".bak"]) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch { /* try the backup */ }
  }
  return null;
}

/**
 * Brings one transcript's rows up to date. Reads only the bytes after the stored offset (a shrunk file is read again
 * from the start) and re-reads the settings file when its mtime or size changed. Returns true when anything changed.
 */
export function ingestTranscript(db: Database, projectKey: string, file: string): boolean {
  let st;
  try { st = statSync(file); } catch { return false; }
  const settingsPath = file.replace(/\.jsonl$/, ".settings.json");
  let sst: ReturnType<typeof statSync> | undefined;
  try { sst = statSync(settingsPath); } catch { /* none */ }
  const id = path.basename(file, ".jsonl");
  const prev = db.query("SELECT * FROM session_ingest WHERE session_id = ?").get(id) as any;
  const row0 = db.query("SELECT * FROM sessions WHERE session_id = ?").get(id) as Row | null;
  const settingsSame = prev && (sst ? prev.settings_mtime_ms === sst.mtimeMs && prev.settings_size === sst.size : prev.settings_mtime_ms === -1);
  const current = prev && row0 && prev.schema_version === INGEST_SCHEMA_VERSION;
  if (current && prev.transcript_size === st.size && prev.transcript_mtime_ms === st.mtimeMs && settingsSame && row0!.project_key === projectKey) return false;

  const restart = !current || st.size < prev.transcript_offset;
  let offset = restart ? 0 : prev.transcript_offset;
  let skipped = restart ? 0 : prev.transcript_skipped_lines;
  let messages = restart ? 0 : prev.transcript_messages_count;
  const row: Row = restart || !row0
    ? {
        session_id: id, project_key: projectKey, cwd: null, title: null, owner: null, parent: null, calling_session_id: null, calling_tool_use_id: null,
        mission: null, tags: "{}", has_user_visible_messages: null, archived_at: null, first_event_at: null, last_event_at: null, messages_count: 0,
        host_id: null, worktree: null, pinned: 0, preview: "", transcript_path: file,
      }
    : { ...row0, project_key: projectKey, transcript_path: file };

  if (st.size > offset) {
    const chunk = readRange(file, offset, st.size);
    let visible = row.has_user_visible_messages === 1;
    let start = 0;
    let sawLine = false;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) break; // a half-written last line waits for the next ingest
      const line = chunk.toString("utf8", start, nl);
      start = nl + 1;
      sawLine = true;
      if (!line.trim()) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { skipped++; continue; }
      if (!o || typeof o !== "object") { skipped++; continue; }
      const t = stamp(o.timestamp);
      if (t !== null) { row.first_event_at ??= t; row.last_event_at = Math.max(row.last_event_at ?? 0, t); }
      if (o.type === "session_start" && row.cwd === null) {
        row.cwd = typeof o.cwd === "string" ? o.cwd : null;
        row.title = typeof o.title === "string" ? o.title : null;
        row.owner = typeof o.owner === "string" ? o.owner : null;
        row.parent = typeof o.parent === "string" ? o.parent : null;
        row.calling_session_id = typeof o.callingSessionId === "string" ? o.callingSessionId : null;
        row.calling_tool_use_id = typeof o.callingToolUseId === "string" ? o.callingToolUseId : null;
        row.host_id = typeof o.hostId === "string" ? o.hostId : null;
      } else if (o.type === "session_title" && typeof o.title === "string") {
        row.title = o.title;
      } else if (o.type === "message") {
        messages++;
        if (!visible && visibleUser(o)) {
          visible = true;
          const text = Array.isArray(o.message.content) ? o.message.content.find((b: any) => b?.type === "text")?.text : "";
          row.preview = String(text ?? "").slice(0, 400);
        }
      }
    }
    offset += start;
    if (sawLine) row.has_user_visible_messages = visible ? 1 : 0;
  }
  row.messages_count = messages;

  const s = settingsOf(settingsPath);
  if (s) {
    if (typeof s.title === "string" && s.title) row.title = s.title;
    const tags = Array.isArray(s.tags) ? s.tags : [];
    row.tags = JSON.stringify(Object.fromEntries(tags.filter((x: any) => x && typeof x.name === "string").map((x: any) => [x.name, 1])));
    row.archived_at = typeof s.archivedAt === "string" ? s.archivedAt : null;
    row.pinned = s.pinned === true ? 1 : 0;
    row.worktree = s.worktree ? JSON.stringify(s.worktree) : null;
    row.mission = typeof s.mission === "string" ? s.mission : null;
  } else {
    row.tags = "{}"; row.archived_at = null; row.pinned = 0; row.worktree = null;
  }
  if (row.last_event_at === null) row.last_event_at = Math.floor(st.mtimeMs);

  db.transaction(() => {
    db.query(
      `INSERT INTO sessions (session_id, project_key, cwd, title, owner, parent, calling_session_id, calling_tool_use_id, mission, tags, has_user_visible_messages,
         archived_at, first_event_at, last_event_at, messages_count, host_id, worktree, pinned, preview, transcript_path)
       VALUES ($session_id, $project_key, $cwd, $title, $owner, $parent, $calling_session_id, $calling_tool_use_id, $mission, $tags, $has_user_visible_messages,
         $archived_at, $first_event_at, $last_event_at, $messages_count, $host_id, $worktree, $pinned, $preview, $transcript_path)
       ON CONFLICT(session_id) DO UPDATE SET project_key=excluded.project_key, cwd=excluded.cwd, title=excluded.title, owner=excluded.owner, parent=excluded.parent,
         calling_session_id=excluded.calling_session_id, calling_tool_use_id=excluded.calling_tool_use_id, mission=excluded.mission, tags=excluded.tags,
         has_user_visible_messages=excluded.has_user_visible_messages, archived_at=excluded.archived_at, first_event_at=excluded.first_event_at,
         last_event_at=excluded.last_event_at, messages_count=excluded.messages_count, host_id=excluded.host_id, worktree=excluded.worktree,
         pinned=excluded.pinned, preview=excluded.preview, transcript_path=excluded.transcript_path`,
    ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => ["$" + k, v])) as any);
    db.query(
      `INSERT INTO session_ingest (session_id, transcript_mtime_ms, transcript_size, transcript_offset, transcript_skipped_lines, transcript_messages_count,
         settings_mtime_ms, settings_size, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET transcript_mtime_ms=excluded.transcript_mtime_ms, transcript_size=excluded.transcript_size,
         transcript_offset=excluded.transcript_offset, transcript_skipped_lines=excluded.transcript_skipped_lines,
         transcript_messages_count=excluded.transcript_messages_count, settings_mtime_ms=excluded.settings_mtime_ms,
         settings_size=excluded.settings_size, schema_version=excluded.schema_version`,
    ).run(id, st.mtimeMs, st.size, offset, skipped, messages, sst ? sst.mtimeMs : -1, sst ? sst.size : -1, INGEST_SCHEMA_VERSION);
  })();
  return true;
}

/** Ingests every transcript in the project folder(s) and drops rows whose file is gone. `projectKey` limits the scan to one folder. */
export function refreshIndex(db: Database, projectKey?: string): void {
  const root = sessionsDir();
  const keys: string[] = [];
  if (projectKey !== undefined) keys.push(projectKey);
  else {
    keys.push("");
    try { for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) keys.push(e.name); } catch { /* none yet */ }
  }
  for (const key of keys) {
    const dir = path.join(root, key);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* folder missing */ }
    const seen = new Set<string>();
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      seen.add(path.basename(n, ".jsonl"));
      try { ingestTranscript(db, key, path.join(dir, n)); } catch { /* one bad file never stops the picker */ }
    }
    for (const r of db.query("SELECT session_id FROM sessions WHERE project_key = ?").all(key) as { session_id: string }[]) {
      if (!seen.has(r.session_id)) db.query("DELETE FROM sessions WHERE session_id = ?").run(r.session_id);
    }
  }
}

export interface PickerRow {
  sessionId: string; title: string; cwd: string; preview: string; lastEventAt: number; pinned: boolean; archivedAt: string | null;
  tags: Record<string, unknown>; messagesCount: number;
}

/**
 * Picker query (spec 12.1): rows of the current project_key, newest last_event_at first; subagent-tagged rows and rows
 * with has_user_visible_messages = 0 are hidden (NULL means unknown, which is shown). Pinned rows come first.
 */
export function queryPicker(db: Database, o: { cwd?: string; includeArchived?: boolean; limit?: number } = {}): PickerRow[] {
  const where = ["COALESCE(json_extract(tags, '$.subagent'), 0) = 0", "(has_user_visible_messages IS NULL OR has_user_visible_messages != 0)"];
  const args: (string | number)[] = [];
  if (o.cwd) { where.push("project_key = ?"); args.push(projectSlug(o.cwd)); }
  if (!o.includeArchived) where.push("archived_at IS NULL");
  const sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY pinned DESC, last_event_at DESC${o.limit && o.limit > 0 ? " LIMIT ?" : ""}`;
  if (o.limit && o.limit > 0) args.push(Math.floor(o.limit));
  return (db.query(sql).all(...args) as any[]).map((r) => ({
    sessionId: r.session_id, title: r.title ?? "New Session", cwd: r.cwd ?? "", preview: r.preview ?? "", lastEventAt: r.last_event_at ?? 0,
    pinned: r.pinned === 1, archivedAt: r.archived_at ?? null, tags: JSON.parse(r.tags || "{}"), messagesCount: r.messages_count ?? 0,
  }));
}
