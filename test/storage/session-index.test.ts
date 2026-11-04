// Session index (spec 12.1): migrations, incremental ingest by byte offset, picker hide rules, fallback to the file scan.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendMessage, createSession } from "../../src/storage/transcript.ts";
import { updateSessionSettings } from "../../src/storage/session-settings.ts";
import { indexDbPath, loadMigrations, migrate, openSessionIndex, queryPicker, refreshIndex, SessionIndexError } from "../../src/storage/session-index.ts";
import { closeSessionIndexes, listSessionEntries } from "../../src/storage/session-list.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
let cwd: string;
beforeEach(() => { env = tmpEnv(); cwd = path.join(env.root, "proj"); mkdirSync(cwd); });
afterEach(() => { closeSessionIndexes(); env.cleanup(); });

const user = (id: string, t: string, extra: object = {}) => ({ id, role: "user" as const, content: [{ type: "text" as const, text: t }], ...extra });

test("migrations: ledger with checksums, no IF NOT EXISTS, a changed file fails loudly", () => {
  const ms = loadMigrations();
  expect(ms.length).toBeGreaterThan(0);
  for (const m of ms) expect(m.sql.toUpperCase()).not.toContain("IF NOT EXISTS");
  const db = openSessionIndex();
  const ledger = db.query("SELECT version, name, checksum FROM schema_migrations").all() as any[];
  expect(ledger.map((r) => r.checksum)).toEqual(ms.map((m) => m.checksum));
  expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
  expect(tables).toEqual(expect.arrayContaining(["sessions", "session_ingest", "schema_migrations", "meta"]));
  migrate(db); // idempotent: already in the ledger
  expect(() => migrate(db, ms.map((m) => ({ ...m, checksum: "changed" })))).toThrow(SessionIndexError);
  db.close();
});

test("incremental ingest reads from the stored byte offset and leaves a half-written line for later", async () => {
  const f = createSession({ id: "s1", cwd });
  await appendMessage(f, user("context-t1", "reminder", { visibility: "llm_only" }), null);
  await appendMessage(f, user("t1", "first question"), "context-t1");
  const db = openSessionIndex();
  const key = path.basename(f.dir);
  refreshIndex(db, key);
  const ing = () => db.query("SELECT * FROM session_ingest WHERE session_id = 's1'").get() as any;
  const row = () => db.query("SELECT * FROM sessions WHERE session_id = 's1'").get() as any;
  expect(ing().transcript_offset).toBe(statSync(f.transcriptPath).size);
  expect(row()).toMatchObject({ messages_count: 2, has_user_visible_messages: 1, preview: "first question", project_key: key, cwd });
  const offset1 = ing().transcript_offset;

  // Corrupt the already-read bytes on disk without changing the size: an incremental ingest must not re-read them.
  await appendMessage(f, { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] }, "t1");
  appendFileSync(f.transcriptPath, '{"type":"message","id":"half'); // no newline yet
  refreshIndex(db, key);
  expect(row().messages_count).toBe(3);
  expect(ing().transcript_offset).toBeGreaterThan(offset1);
  expect(ing().transcript_offset).toBeLessThan(statSync(f.transcriptPath).size); // the half line is not consumed
  appendFileSync(f.transcriptPath, `","parentId":null,"timestamp":"${new Date().toISOString()}","seq":9,"message":{"role":"user","content":[{"type":"text","text":"x"}]}}\n`);
  refreshIndex(db, key);
  expect(row().messages_count).toBe(4);
  expect(ing().transcript_offset).toBe(statSync(f.transcriptPath).size);
  db.close();
});

test("a shrunk transcript is read again from the start; a vanished file drops its row", async () => {
  const f = createSession({ id: "s2", cwd });
  await appendMessage(f, user("t1", "hello there"), null);
  await appendMessage(f, user("t2", "again"), "t1");
  const db = openSessionIndex();
  const key = path.basename(f.dir);
  refreshIndex(db, key);
  expect((db.query("SELECT messages_count c FROM sessions WHERE session_id='s2'").get() as any).c).toBe(2);
  const start = (await Bun.file(f.transcriptPath).text()).split("\n")[0]!;
  writeFileSync(f.transcriptPath, start + "\n");
  refreshIndex(db, key);
  expect(db.query("SELECT messages_count c, has_user_visible_messages v FROM sessions WHERE session_id='s2'").get()).toEqual({ c: 0, v: 0 });
  Bun.spawnSync(["rm", f.transcriptPath]);
  refreshIndex(db, key);
  expect(db.query("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) n FROM session_ingest").get()).toEqual({ n: 0 }); // deleted along with the session
  db.close();
});

test("a session moved to another folder keeps its row, whatever order the folders are read in", async () => {
  // Promote moves a side chat from <sessions>/btw into the project folder. The folder read order depends on the disk.
  const f = createSession({ id: "moved", cwd });
  await appendMessage(f, user("m1", "side question"), null);
  const key = path.basename(f.dir);
  const btw = path.join(path.dirname(f.dir), "btw");
  mkdirSync(btw, { recursive: true });
  const db = openSessionIndex();
  renameSync(f.transcriptPath, path.join(btw, "moved.jsonl"));
  refreshIndex(db, "btw");
  expect(db.query("SELECT project_key k FROM sessions WHERE session_id='moved'").get()).toEqual({ k: "btw" });
  renameSync(path.join(btw, "moved.jsonl"), f.transcriptPath);
  refreshIndex(db, key); // the project folder first,
  refreshIndex(db, "btw"); // then the folder the file left
  expect(db.query("SELECT project_key k FROM sessions WHERE session_id='moved'").get()).toEqual({ k: key });
  expect(queryPicker(db, { cwd }).map((r) => r.sessionId)).toEqual(["moved"]);
  db.close();
});

test("picker rules: current project only, newest first, subagent and no-visible-message rows hidden", async () => {
  const other = path.join(env.root, "other");
  mkdirSync(other);
  const mk = async (id: string, dir: string, at: string, opts: { visible?: boolean; subagent?: boolean } = {}) => {
    const f = createSession({ id, cwd: dir });
    const ts = new Date(at).toISOString();
    const lines: object[] = [{ type: "message", id: "context-" + id, parentId: null, timestamp: ts, seq: 0, message: { role: "user", visibility: "llm_only", content: [{ type: "text", text: "ctx" }] } }];
    if (opts.visible !== false) lines.push({ type: "message", id: "u-" + id, parentId: null, timestamp: ts, seq: 1, message: { role: "user", content: [{ type: "text", text: `hi from ${id}` }] } });
    appendFileSync(f.transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (opts.subagent) updateSessionSettings(f, { tags: [{ name: "subagent", metadata: { subagent: 1 } }] });
    return f;
  };
  await mk("old", cwd, "2026-01-01T00:00:00Z");
  await mk("new", cwd, "2026-03-01T00:00:00Z");
  await mk("mid", cwd, "2026-02-01T00:00:00Z");
  await mk("sub", cwd, "2026-04-01T00:00:00Z", { subagent: true });
  await mk("empty", cwd, "2026-05-01T00:00:00Z", { visible: false });
  await mk("elsewhere", other, "2026-06-01T00:00:00Z");
  const rows = listSessionEntries({ cwd });
  expect(rows.map((r) => r.sessionId)).toEqual(["new", "mid", "old"]);
  expect(rows[0]!.updatedAt).toBe("2026-03-01T00:00:00.000Z");
  expect(listSessionEntries({}).map((r) => r.sessionId)).toEqual(["elsewhere", "new", "mid", "old"]);
  // Rows go through the SQLite index.
  const db = new Database(indexDbPath(), { readonly: true });
  expect((db.query("SELECT COUNT(*) n FROM sessions").get() as any).n).toBe(6);
  expect(queryPicker(db, { cwd }).length).toBe(3);
  db.close();
});

test("settings changes (title, pin, archive) show up without re-reading the transcript", async () => {
  const f = createSession({ id: "s3", cwd });
  await appendMessage(f, user("t1", "hello"), null);
  expect(listSessionEntries({ cwd })[0]!.title).toBe("hello");
  updateSessionSettings(f, { title: "Named", pinned: true });
  const r = listSessionEntries({ cwd })[0]!;
  expect(r).toMatchObject({ title: "Named", pinned: true });
  updateSessionSettings(f, { archivedAt: new Date().toISOString() });
  expect(listSessionEntries({ cwd })).toEqual([]);
  expect(listSessionEntries({ cwd, includeArchived: true }).length).toBe(1);
});

test("an unusable index falls back to the file scan", async () => {
  const f = createSession({ id: "s4", cwd });
  await appendMessage(f, user("t1", "still listed"), null);
  closeSessionIndexes();
  mkdirSync(path.dirname(indexDbPath()), { recursive: true });
  writeFileSync(indexDbPath(), "this is not a sqlite database at all, just text".repeat(50));
  const rows = listSessionEntries({ cwd });
  expect(rows.map((r) => r.sessionId)).toEqual(["s4"]);
});
