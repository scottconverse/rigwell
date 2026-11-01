// Markdown + YAML frontmatter parsing shared by skills and custom agents (spec §5.8 parsing rules).
export interface Frontmatter {
  /** Parsed metadata; null when there was no frontmatter or it could not be parsed at all. */
  data: Record<string, unknown> | null;
  /** True when a frontmatter block existed but was neither valid YAML nor simple key: value. */
  broken: boolean;
  body: string;
}

function simpleKeyValue(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return null;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Split `---` frontmatter. YAML first, then a `key: value` fallback, else no metadata + whole file as body. */
export function parseFrontmatter(src: string): Frontmatter {
  const text = src.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: null, broken: false, body: text };
  const raw = m[1];
  const body = text.slice(m[0].length);
  try {
    const y = (Bun as any).YAML.parse(raw);
    if (y && typeof y === "object" && !Array.isArray(y)) return { data: y as Record<string, unknown>, broken: false, body };
    if (y == null) return { data: {}, broken: false, body };
  } catch { /* fall through */ }
  const kv = simpleKeyValue(raw);
  if (kv) return { data: kv, broken: false, body };
  return { data: null, broken: true, body: text };
}

/** "a, b" or ["a","b"] -> ["a","b"]; anything else -> undefined. */
export function toStringList(v: unknown): string[] | undefined {
  if (typeof v === "string") { const l = v.split(",").map((s) => s.trim()).filter(Boolean); return l.length ? l : undefined; }
  if (Array.isArray(v)) { const l = v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean); return l.length ? l : undefined; }
  return undefined;
}

/** Lowercase; chars outside a-z0-9- become `-` (spec §5.8 / §12.2). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
