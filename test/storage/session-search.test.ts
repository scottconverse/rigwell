// Session search (spec 12.1): spans, bloom filters, triggers, lexical and semantic search, protocol method.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { appendMessage, createSession } from "../../src/storage/transcript.ts";
import { updateSessionSettings } from "../../src/storage/session-settings.ts";
import { openSessionIndex, refreshIndex } from "../../src/storage/session-index.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { embedPendingSpans, lexicalSearch, semanticSearch } from "../../src/storage/session-search.ts";
import { bloomMayContain, buildBloom, chunkText, proseOf } from "../../src/storage/search-text.ts";
import { HashingEmbedder, quantize, type Embedder } from "../../src/storage/embedder.ts";
import { inproc } from "../e2e/inproc.ts";
import { tmpEnv } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
let cwd: string;
beforeEach(() => { env = tmpEnv(); cwd = path.join(env.root, "proj"); mkdirSync(cwd); });
afterEach(() => { closeSessionIndexes(); env.cleanup(); });

const msg = (id: string, role: "user" | "assistant", text: string) => ({ id, role, content: [{ type: "text" as const, text }] });
async function session(id: string, texts: string[], opts: { subagent?: boolean } = {}) {
  const f = createSession({ id, cwd });
  let parent: string | null = null;
  for (let i = 0; i < texts.length; i++) {
    const m = msg(`${id}-m${i}`, i % 2 === 0 ? "user" : "assistant", texts[i]!);
    await appendMessage(f, m, parent);
    parent = m.id;
  }
  if (opts.subagent) updateSessionSettings(f, { tags: [{ name: "subagent" }] });
  return f;
}
const epoch = (db: any) => Number((db.query("SELECT value FROM meta WHERE key='vector_epoch'").get() as any).value);

test("prose extraction drops system reminders, tool blocks and llm_only context", () => {
  const rec = (message: any, id = "x") => ({ type: "message", id, message });
  expect(proseOf(rec({ role: "user", content: [{ type: "text", text: "<system-reminder>\nsecret\n</system-reminder>\nfix the parser" }] }))).toBe("fix the parser");
  expect(proseOf(rec({ role: "assistant", content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "done" }] }))).toBe("done");
  expect(proseOf(rec({ role: "user", content: [{ type: "tool_result", content: "x" }] }))).toBe("");
  expect(proseOf(rec({ role: "user", visibility: "llm_only", content: [{ type: "text", text: "ctx" }] }))).toBe("");
  expect(chunkText("a ".repeat(2000), 1200).every((c) => c.length <= 1200)).toBe(true);
});

test("ingest writes spans with 1-based line ranges and event ids, plus a term filter; appends continue the numbering", async () => {
  const f = await session("s1", ["alpha question about kubernetes", "assistant explains helm charts"]);
  const db = openSessionIndex();
  const key = path.basename(f.dir);
  refreshIndex(db, key);
  const lines = readFileSync(f.transcriptPath, "utf8").split("\n").filter(Boolean);
  const spans = db.query("SELECT * FROM session_spans WHERE session_id='s1' ORDER BY span_index").all() as any[];
  expect(spans.length).toBe(2);
  expect(spans[0]).toMatchObject({ span_index: 0, text: "alpha question about kubernetes", first_event_id: "s1-m0", last_event_id: "s1-m0" });
  expect(lines[spans[0].line_start - 1]).toContain('"id":"s1-m0"');
  expect(lines[spans[1].line_start - 1]).toContain('"id":"s1-m1"');
  expect(spans[0].text_sha256).toHaveLength(64);
  expect((db.query("SELECT COUNT(*) n FROM session_term_filters").get() as any).n).toBe(1);

  await appendMessage(f, msg("s1-m2", "user", "third turn mentions postgres"), "s1-m1");
  refreshIndex(db, key);
  const all = db.query("SELECT span_index, line_start FROM session_spans WHERE session_id='s1' ORDER BY span_index").all() as any[];
  expect(all.map((r) => r.span_index)).toEqual([0, 1, 2]);
  expect(lines.length + 1).toBe(all[2].line_start);
  expect(lexicalSearch(db, "postgres").map((h) => h.sessionId)).toEqual(["s1"]);
  db.close();
});

test("bloom filter: words and prefixes pass, absent words skip", () => {
  const b = buildBloom(["kubernetes", "helm", "internationalization"]);
  for (const t of ["kubernetes", "kube", "he", "helm", "internationalizationextra"]) expect(bloomMayContain(b, t)).toBe(true);
  const misses = ["zebra", "quokka", "mongo", "xylophone", "jazz"].filter((t) => !bloomMayContain(b, t));
  expect(misses.length).toBeGreaterThanOrEqual(4);
  expect(bloomMayContain(b, "k")).toBe(true); // one-letter terms are never filtered
});

test("lexical search skips sessions by bloom filter, then scans spans; prefix and multi-word AND", async () => {
  const a = await session("a1", ["how do I configure kubernetes ingress", "use an ingress controller with annotations"]);
  await session("b1", ["write a haiku about autumn", "leaves fall down"]);
  const db = openSessionIndex();
  refreshIndex(db);
  const hits = lexicalSearch(db, "kubernetes ingress");
  expect(hits.map((h) => h.sessionId)).toEqual(["a1"]);
  expect(hits[0]).toMatchObject({ spanIndex: 0, firstEventId: "a1-m0" });
  expect(hits[0]!.snippet).toContain("kubernetes");
  expect(lexicalSearch(db, "kuber").map((h) => h.sessionId)).toEqual(["a1"]); // prefix
  expect(lexicalSearch(db, "kubernetes autumn")).toEqual([]); // words in different sessions
  expect(lexicalSearch(db, "nothingmatches")).toEqual([]);

  // Prove the filter is what skips: empty the filter of a1 (all zero bits) and the session is no longer scanned.
  db.query("UPDATE session_term_filters SET filter = ? WHERE session_id='a1'").run(buildBloom([]));
  expect(lexicalSearch(db, "kubernetes")).toEqual([]);
  expect(a.id).toBe("a1");
  db.close();
});

test("vector_epoch bumps on span changes, not on embedding writes; settings triggers mark settings stale", async () => {
  const f = await session("e1", ["epoch test message"]);
  const db = openSessionIndex();
  expect(epoch(db)).toBe(0);
  refreshIndex(db, path.basename(f.dir));
  const e1 = epoch(db);
  expect(e1).toBeGreaterThan(0);
  await embedPendingSpans(db);
  expect(epoch(db)).toBe(e1);
  await appendMessage(f, msg("e1-m1", "assistant", "more"), "e1-m0");
  refreshIndex(db, path.basename(f.dir));
  const e2 = epoch(db);
  expect(e2).toBeGreaterThan(e1);
  db.query("DELETE FROM session_spans WHERE session_id='e1' AND span_index=1").run();
  expect(epoch(db)).toBeGreaterThan(e2);

  const ing = () => (db.query("SELECT settings_mtime_ms m FROM session_ingest WHERE session_id='e1'").get() as any).m;
  updateSessionSettings(f, { title: "t" });
  refreshIndex(db, path.basename(f.dir));
  expect(ing()).toBeGreaterThan(0);
  db.query("UPDATE sessions SET settings_write_seq = settings_write_seq + 1 WHERE session_id='e1'").run();
  expect(ing()).toBe(-1);
  db.query("UPDATE session_ingest SET settings_mtime_ms = 5").run();
  db.query("UPDATE sessions SET owner = 'someone' WHERE session_id='e1'").run(); // owner is not a daemon field: no change
  expect(ing()).toBe(5);
  db.query("UPDATE sessions SET org_id = 'org' WHERE session_id='e1'").run();
  expect(ing()).toBe(-1);
  db.close();
});

test("a session that disappears takes its spans and filter with it", async () => {
  const f = await session("g1", ["gone soon"]);
  const db = openSessionIndex();
  refreshIndex(db);
  unlinkSync(f.transcriptPath);
  refreshIndex(db);
  expect((db.query("SELECT (SELECT COUNT(*) FROM session_spans) + (SELECT COUNT(*) FROM session_term_filters) n").get() as any).n).toBe(0);
  db.close();
});

test("int8 quantization round-trips within one step", () => {
  const e = new HashingEmbedder(64);
  const v = e.vectorOf("quantize this vector please");
  const { scale, q } = quantize(v);
  for (let i = 0; i < v.length; i++) expect(Math.abs(q[i]! * scale - v[i]!)).toBeLessThanOrEqual(scale / 2 + 1e-9);
});

test("semantic search: int8 vectors in session_spans, subagent sessions excluded, other spaces ignored", async () => {
  await session("m1", ["please refactor the database connection pooling code", "pooling is now shared across workers"]);
  await session("m2", ["recipe for chocolate cake with butter and sugar"]);
  await session("sub", ["refactor the database connection pooling in the worker"], { subagent: true });
  const db = openSessionIndex();
  refreshIndex(db);
  const hits = await semanticSearch(db, "database connection pooling refactor");
  expect(hits[0]!.sessionId).toBe("m1");
  expect(hits.map((h) => h.sessionId)).not.toContain("sub");
  const row = db.query("SELECT scale, vector, embedding_space, text_sha256, synced_at FROM session_spans WHERE session_id='m1' AND span_index=0").get() as any;
  expect(row.vector.byteLength).toBe(256);
  expect(row.embedding_space).toBe("local-hash-v1-256");
  expect(row.scale).toBeGreaterThan(0);
  expect((await semanticSearch(db, "chocolate cake butter"))[0]!.sessionId).toBe("m2");

  // A pluggable embedder in another space: vectors are recomputed in that space, never mixed.
  const calls: string[][] = [];
  const fake: Embedder = {
    space: "fake-2d", dims: 2,
    async embed(texts) { calls.push(texts); return texts.map((t) => Float32Array.from(t.includes("cake") ? [1, 0] : [0, 1])); },
  };
  const h2 = await semanticSearch(db, "cake", { embedder: fake });
  expect(h2.map((h) => h.sessionId)).toEqual(["m2"]);
  expect(calls.length).toBeGreaterThan(0);
  expect((db.query("SELECT DISTINCT embedding_space s FROM session_spans").all() as any[]).map((r) => r.s)).toEqual(["fake-2d"]);
  db.close();
});

test("rigwell.search_sessions protocol method", async () => {
  await session("p1", ["tell me about websocket reconnect backoff"]);
  await session("p2", ["unrelated gardening notes"]);
  const c = inproc();
  const lex = await c.call("search_sessions", { query: "websocket", mode: "lexical", cwd });
  expect(lex.hits.map((h: any) => h.sessionId)).toEqual(["p1"]);
  const sem = await c.call("search_sessions", { query: "websocket reconnect", mode: "semantic", limit: 1 });
  expect(sem.hits).toHaveLength(1);
  expect(sem.hits[0].sessionId).toBe("p1");
  await expect(c.call("search_sessions", { query: "x", mode: "fuzzy" })).rejects.toThrow(/mode/);
  await expect(c.call("search_sessions", { query: "  " })).rejects.toThrow(/query/);
});

test("rigwell sessions search CLI", async () => {
  await session("c1", ["searching with the command line tool works"]);
  const run = (...a: string[]) => Bun.spawnSync(["bun", path.resolve(import.meta.dir, "../../src/cli/main.ts"), "sessions", "search", ...a, "--cwd", cwd], { env: { ...process.env, RIGWELL_HOME: env.rigwellHome } });
  const r = run("command", "line");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("c1");
  const j = JSON.parse(run("tool", "--json", "--semantic").stdout.toString());
  expect(j[0].sessionId).toBe("c1");
  expect(run("zzzzz").stdout.toString()).toContain("No matches");
});
