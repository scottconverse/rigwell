// Cache monitor (spec §6.3): compares every request with the previous one for the session, logs the first
// divergent block and its cause, and tracks the cache-read share and the strict-append share.
import type { Message, ModelRequest, TokenUsage } from "../core/types.ts";

/** Canonical, cache-marker-free form of a request, block by block. */
export interface Fingerprint {
  system: string[];
  tools: string[];
  /** Per message: id and one string per content block (an OpenAI reasoning replay counts as a block). */
  messages: { id: string; role: string; blocks: string[] }[];
}

function blockKey(b: any): string {
  const { cache: _c, ...rest } = b;
  return JSON.stringify(rest);
}

export function fingerprint(req: Pick<ModelRequest, "system" | "tools" | "messages">): Fingerprint {
  return {
    system: [...req.system],
    tools: req.tools.map((t) => JSON.stringify([t.name, t.description, t.inputSchema])),
    messages: req.messages.map((m: Message) => ({
      id: m.id, role: m.role,
      blocks: [...(m.openaiReasoning?.length ? [JSON.stringify({ reasoning: m.openaiReasoning })] : []), ...m.content.map(blockKey)],
    })),
  };
}

export interface Divergence {
  /** 1-based number of the request in this session. */
  request: number;
  /** system[i] | tools | messages[i].content[j] | messages */
  block: string;
  cause: string;
  at: string;
}

export interface CacheStats {
  requests: number;
  /** Requests that had a previous request to compare with. */
  comparable: number;
  strictAppend: number;
  strictAppendShare: number | null;
  /** cacheRead / (input + cacheRead + cacheCreation), summed over requests. */
  cacheReadShareTokenWeighted: number | null;
  cacheReadShareMedian: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  divergences: Divergence[];
}

const MAX_DIVERGENCES = 20;

export class CacheMonitor {
  private prev?: Fingerprint;
  private n = 0;
  private comparable = 0;
  private strict = 0;
  private shares: number[] = [];
  private sums = { input: 0, read: 0, create: 0 };
  private divergences: Divergence[] = [];
  private pendingNote?: string;

  constructor(private log: (m: string) => void = () => {}) {}

  /** Names the reason for a divergence the session knows about (model change, compaction...). */
  expectBreak(cause: string) { this.pendingNote = cause; }

  /** Call once per main-chain request, before it is sent. Returns the divergence, if any. */
  observe(req: Pick<ModelRequest, "system" | "tools" | "messages">): Divergence | null {
    this.n++;
    const cur = fingerprint(req);
    const prev = this.prev;
    this.prev = cur;
    const note = this.pendingNote;
    this.pendingNote = undefined;
    if (!prev) return null;
    this.comparable++;
    const d = this.firstDivergence(prev, cur);
    if (!d) { this.strict++; return null; }
    const div: Divergence = { request: this.n, block: d.block, cause: note ?? d.cause, at: new Date().toISOString() };
    this.divergences.push(div);
    if (this.divergences.length > MAX_DIVERGENCES) this.divergences.shift();
    this.log(`[cache] request ${div.request} is not a strict extension of the previous one: first divergent block ${div.block}; cause: ${div.cause}`);
    return div;
  }

  private firstDivergence(a: Fingerprint, b: Fingerprint): { block: string; cause: string } | null {
    for (let i = 0; i < Math.max(a.system.length, b.system.length); i++) {
      if (a.system[i] !== b.system[i]) return { block: `system[${i}]`, cause: "system prompt changed" };
    }
    if (a.tools.length !== b.tools.length) return { block: "tools", cause: `tools array changed (${a.tools.length} -> ${b.tools.length} tools)` };
    for (let i = 0; i < a.tools.length; i++) {
      if (a.tools[i] !== b.tools[i]) return { block: `tools[${i}]`, cause: `tool definition changed (${JSON.parse(b.tools[i]!)[0]})` };
    }
    if (b.messages.length < a.messages.length) {
      return { block: "messages", cause: `history shortened (${a.messages.length} -> ${b.messages.length} messages)` };
    }
    for (let i = 0; i < a.messages.length; i++) {
      const x = a.messages[i]!, y = b.messages[i]!;
      if (x.id !== y.id || x.role !== y.role) return { block: `messages[${i}]`, cause: `history rewritten (message ${x.id} replaced by ${y.id})` };
      for (let j = 0; j < Math.max(x.blocks.length, y.blocks.length); j++) {
        if (x.blocks[j] !== y.blocks[j]) return { block: `messages[${i}].content[${j}]`, cause: `earlier message edited (${x.id})` };
      }
    }
    return null;
  }

  /** Call with the usage the provider reported for the request just sent. */
  recordUsage(u: Pick<TokenUsage, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens">) {
    const total = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    this.sums.input += u.inputTokens;
    this.sums.read += u.cacheReadTokens;
    this.sums.create += u.cacheCreationTokens;
    if (total > 0) this.shares.push(u.cacheReadTokens / total);
  }

  stats(): CacheStats {
    const total = this.sums.input + this.sums.read + this.sums.create;
    const sorted = [...this.shares].sort((x, y) => x - y);
    const mid = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
    return {
      requests: this.n, comparable: this.comparable, strictAppend: this.strict,
      strictAppendShare: this.comparable ? this.strict / this.comparable : null,
      cacheReadShareTokenWeighted: total ? this.sums.read / total : null,
      cacheReadShareMedian: mid,
      inputTokens: this.sums.input, cacheReadTokens: this.sums.read, cacheCreationTokens: this.sums.create,
      divergences: [...this.divergences],
    };
  }
}
