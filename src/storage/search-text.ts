// Text helpers for the local search index (spec 12.1): span extraction from transcript records, word tokens, and the
// per-session bloom filter of words and word prefixes.
import { createHash } from "node:crypto";

export const SPAN_MAX_CHARS = 1200;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** User and assistant prose of one transcript record, system reminders removed. Empty for anything else. */
export function proseOf(o: any): string {
  if (o?.type !== "message") return "";
  const m = o.message;
  if (m?.role !== "user" && m?.role !== "assistant") return "";
  if (m.visibility === "llm_only" || m.visibility === "user_only" || String(o.id ?? "").startsWith("context-")) return "";
  const parts: string[] = [];
  if (typeof m.content === "string") parts.push(m.content);
  else if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  return parts.join("\n\n").replace(REMINDER, "").replace(/<system-reminder>[\s\S]*$/, "").trim();
}

/** Splits prose into chunks of at most `max` characters, preferring paragraph, then line, then word boundaries. */
export function chunkText(text: string, max = SPAN_MAX_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 3) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 3) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 3) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Lowercased word tokens (letters, digits, underscore). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- bloom filter ----------
// Blob layout: "BLM1", k (1 byte), then the bit array (a power-of-two number of bytes). Items are words and their
// prefixes of length 2..PREFIX_MAX; a longer query word is probed by its PREFIX_MAX prefix.
export const PREFIX_MAX = 10;
const K = 4;

function hashes(item: string, bits: number): number[] {
  const d = createHash("sha256").update(item).digest();
  const h1 = d.readUInt32LE(0), h2 = d.readUInt32LE(4) | 1;
  return Array.from({ length: K }, (_, i) => ((h1 + Math.imul(i, h2)) >>> 0) % bits);
}

export function termsOf(words: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const w of words) {
    s.add(w);
    for (let n = 2; n < Math.min(w.length, PREFIX_MAX + 1); n++) s.add(w.slice(0, n));
    if (w.length > PREFIX_MAX) s.add(w.slice(0, PREFIX_MAX));
  }
  return s;
}

export function buildBloom(words: Iterable<string>): Buffer {
  const terms = termsOf(words);
  let bytes = 128;
  while (bytes * 8 < terms.size * 10 && bytes < 4 * 1024 * 1024) bytes *= 2;
  const bits = bytes * 8;
  const buf = Buffer.alloc(5 + bytes);
  buf.write("BLM1", 0, "latin1");
  buf[4] = K;
  for (const t of terms) for (const b of hashes(t, bits)) buf[5 + (b >> 3)]! |= 1 << (b & 7);
  return buf;
}

/** False means the session certainly lacks a word starting with `term`; true means maybe. Terms under 2 characters always pass. */
export function bloomMayContain(filter: Uint8Array, term: string): boolean {
  if (term.length < 2 || !(filter instanceof Uint8Array)) return true;
  const f = Buffer.from(filter.buffer, filter.byteOffset, filter.byteLength);
  if (f.length < 6 || f.toString("latin1", 0, 4) !== "BLM1") return true; // unreadable filter: never skip
  const bits = (f.length - 5) * 8;
  const probe = term.length > PREFIX_MAX ? term.slice(0, PREFIX_MAX) : term;
  return hashes(probe, bits).every((b) => (f[5 + (b >> 3)]! & (1 << (b & 7))) !== 0);
}
