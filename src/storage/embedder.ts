// Embedder interface for semantic session search (spec 12.1), plus the local hashing embedder.
//
// HashingEmbedder is NOT a neural model. It hashes word unigrams, bigrams and character trigrams into a fixed number
// of signed buckets and normalizes the result, so it ranks by shared vocabulary (lexical quality, with some tolerance
// for word forms and typos). It exists so the vector storage and query path work offline with no download or key.
// A real model plugs in by implementing `Embedder` with its own `space` string; vectors stored under another space
// are ignored by queries and recomputed by `embedPendingSpans`.
import { tokenize } from "./search-text.ts";

export interface Embedder {
  /** Names the vector space; stored in session_spans.embedding_space and compared on every query. */
  readonly space: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export class HashingEmbedder implements Embedder {
  readonly space: string;
  constructor(readonly dims = 256) { this.space = `local-hash-v1-${dims}`; }

  private add(v: Float32Array, feature: string, weight: number) {
    const h = fnv1a(feature);
    v[h % this.dims]! += (h & 0x80000000 ? -1 : 1) * weight;
  }

  vectorOf(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const words = tokenize(text);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      this.add(v, "w:" + w, 1);
      if (i > 0) this.add(v, "b:" + words[i - 1] + " " + w, 0.7);
      if (w.length > 3) for (let j = 0; j + 3 <= w.length; j++) this.add(v, "t:" + w.slice(j, j + 3), 0.3);
    }
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
    return v;
  }

  async embed(texts: string[]): Promise<Float32Array[]> { return texts.map((t) => this.vectorOf(t)); }
}

/** int8 quantization: `scale` is max|x| / 127, so x is about q * scale. */
export function quantize(v: Float32Array): { scale: number; q: Int8Array } {
  let m = 0;
  for (const x of v) m = Math.max(m, Math.abs(x));
  const scale = m > 0 ? m / 127 : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i]! / scale)));
  return { scale, q };
}
