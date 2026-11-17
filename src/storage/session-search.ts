// Session search (spec 12.1 "Local search index"). Lexical: skip sessions whose bloom filter lacks a query word, then scan
// the spans of the rest. Semantic: int8 span vectors from a pluggable Embedder; subagent sessions are left out.
// Both return the best span per session, best first.
import type { Database } from "bun:sqlite";
import { projectSlug } from "./paths.ts";
import { type Embedder, HashingEmbedder, quantize } from "./embedder.ts";
import { bloomMayContain, sha256, tokenize } from "./search-text.ts";
import { refreshIndex } from "./session-index.ts";

export interface SearchHit {
  sessionId: string; title: string; cwd: string;
  spanIndex: number; lineStart: number; lineEnd: number; firstEventId: string | null; lastEventId: string | null;
  snippet: string; score: number;
}
export interface SearchOptions { limit?: number; cwd?: string; includeArchived?: boolean }

let defaultEmbedder: Embedder = new HashingEmbedder();
export function setDefaultEmbedder(e: Embedder) { defaultEmbedder = e; }
export function getDefaultEmbedder(): Embedder { return defaultEmbedder; }

const DEFAULT_LIMIT = 20;
const limitOf = (o: SearchOptions) => (o.limit && o.limit > 0 ? Math.floor(o.limit) : DEFAULT_LIMIT);

function scopeWhere(o: SearchOptions, alias = "s"): { sql: string; args: string[] } {
  const where: string[] = [];
  const args: string[] = [];
  if (o.cwd) { where.push(`${alias}.project_key = ?`); args.push(projectSlug(o.cwd)); }
  if (!o.includeArchived) where.push(`${alias}.archived_at IS NULL`);
  return { sql: where.length ? " AND " + where.join(" AND ") : "", args };
}

function snippetOf(text: string, from: number): string {
  const flat = text.replace(/\s+/g, " ");
  const start = Math.max(0, Math.min(from, flat.length) - 60);
  const end = Math.min(flat.length, start + 200);
  return (start > 0 ? "..." : "") + flat.slice(start, end) + (end < flat.length ? "..." : "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every query word must start a word in the span. Score: matches per word, with an exact-word bonus. */
export function lexicalSearch(db: Database, query: string, o: SearchOptions = {}): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const scope = scopeWhere(o);
  const sessions = db.query(
    `SELECT s.session_id, s.title, s.cwd, s.last_event_at, f.filter FROM sessions s JOIN session_term_filters f ON f.session_id = s.session_id WHERE 1=1${scope.sql}`,
  ).all(...scope.args) as { session_id: string; title: string | null; cwd: string | null; last_event_at: number | null; filter: Uint8Array }[];
  const res = terms.map((t) => ({ prefix: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}`, "giu"), exact: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "giu") }));
  const spansOf = db.query("SELECT span_index, line_start, line_end, text, first_event_id, last_event_id FROM session_spans WHERE session_id = ?");
  const hits: (SearchHit & { recent: number })[] = [];
  for (const s of sessions) {
    if (!terms.every((t) => bloomMayContain(s.filter, t))) continue; // skipped without reading a span
    let best: SearchHit | undefined;
    for (const sp of spansOf.all(s.session_id) as any[]) {
      let score = 0;
      let first = -1;
      let ok = true;
      for (const r of res) {
        r.prefix.lastIndex = 0;
        const m = [...sp.text.matchAll(r.prefix)];
        if (!m.length) { ok = false; break; }
        if (first < 0 || m[0]!.index! < first) first = m[0]!.index!;
        r.exact.lastIndex = 0;
        score += m.length + 2 * [...sp.text.matchAll(r.exact)].length;
      }
      if (!ok) continue;
      if (!best || score > best.score) {
        best = {
          sessionId: s.session_id, title: s.title ?? "New Session", cwd: s.cwd ?? "", spanIndex: sp.span_index, lineStart: sp.line_start, lineEnd: sp.line_end,
          firstEventId: sp.first_event_id, lastEventId: sp.last_event_id, snippet: snippetOf(sp.text, first), score,
        };
      }
    }
    if (best) hits.push({ ...best, recent: s.last_event_at ?? 0 });
  }
  hits.sort((a, b) => b.score - a.score || b.recent - a.recent);
  return hits.slice(0, limitOf(o)).map(({ recent: _r, ...h }) => h);
}

/** Embeds spans that have no vector in the embedder's space (or whose text changed). Returns how many were written. */
export async function embedPendingSpans(db: Database, embedder: Embedder = defaultEmbedder, batch = 64): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = db.query(
      `SELECT session_id, span_index, text FROM session_spans WHERE vector IS NULL OR embedding_space IS NOT ? OR text_sha256 IS NULL LIMIT ?`,
    ).all(embedder.space, batch) as { session_id: string; span_index: number; text: string }[];
    if (!rows.length) return done;
    const vecs = await embedder.embed(rows.map((r) => r.text));
    const upd = db.query("UPDATE session_spans SET scale = ?, vector = ?, text_sha256 = ?, embedding_space = ?, synced_at = ? WHERE session_id = ? AND span_index = ?");
    db.transaction(() => {
      rows.forEach((r, i) => {
        const { scale, q } = quantize(vecs[i]!);
        upd.run(scale, Buffer.from(q.buffer, q.byteOffset, q.byteLength), sha256(r.text), embedder.space, Date.now(), r.session_id, r.span_index);
      });
    })();
    done += rows.length;
  }
}

/** Cosine ranking over int8 vectors. Subagent sessions are excluded. Embeds pending spans first (cheap for the local embedder). */
export async function semanticSearch(db: Database, query: string, o: SearchOptions & { embedder?: Embedder } = {}): Promise<SearchHit[]> {
  const embedder = o.embedder ?? defaultEmbedder;
  if (!query.trim()) return [];
  await embedPendingSpans(db, embedder);
  const [qv] = await embedder.embed([query]);
  if (!qv || qv.length !== embedder.dims) return [];
  const scope = scopeWhere(o);
  const rows = db.query(
    `SELECT sp.session_id, sp.span_index, sp.line_start, sp.line_end, sp.text, sp.first_event_id, sp.last_event_id, sp.scale, sp.vector, s.title, s.cwd
       FROM session_spans sp JOIN sessions s ON s.session_id = sp.session_id
      WHERE sp.embedding_space = ? AND sp.vector IS NOT NULL AND COALESCE(json_extract(s.tags, '$.subagent'), 0) = 0${scope.sql}`,
  ).all(embedder.space, ...scope.args) as any[];
  const best = new Map<string, SearchHit>();
  for (const r of rows) {
    const v = new Int8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
    if (v.length !== qv.length) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i]! * qv[i]!;
    const score = dot * r.scale;
    if (score <= 0) continue;
    const cur = best.get(r.session_id);
    if (!cur || score > cur.score) {
      best.set(r.session_id, {
        sessionId: r.session_id, title: r.title ?? "New Session", cwd: r.cwd ?? "", spanIndex: r.span_index, lineStart: r.line_start, lineEnd: r.line_end,
        firstEventId: r.first_event_id, lastEventId: r.last_event_id, snippet: snippetOf(r.text, 0), score: Math.round(score * 1e4) / 1e4,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limitOf(o));
}

/** Refreshes the index for the scope, then searches. */
export async function searchSessionIndex(db: Database, query: string, mode: "lexical" | "semantic", o: SearchOptions = {}): Promise<SearchHit[]> {
  refreshIndex(db, o.cwd ? projectSlug(o.cwd) : undefined);
  return mode === "semantic" ? semanticSearch(db, query, o) : lexicalSearch(db, query, o);
}
