// Per-session result log (spec S4): every inner tool result except plain Read is kept as one JSON
// line, so the model can look results up later with results.search / results.get instead of
// repeating calls. Path: $RIGWELL_HOME/artifacts/scripts/<sessionId>/results.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export function scriptsDir(sessionId: string): string {
  return path.join(rigwellHome(), "artifacts", "scripts", sessionId);
}

export interface LoggedResult {
  job_id: string;
  call: number;
  tool: string;
  input: unknown;
  isError: boolean;
  result: unknown;
  at: string;
}

export interface SearchHit { job_id: string; call: number; tool: string; snippet: string }

const SNIPPET = 240;

export class ResultLog {
  readonly file: string;
  constructor(sessionId: string) {
    const dir = scriptsDir(sessionId);
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "results.jsonl");
  }

  append(e: LoggedResult): void {
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }

  private all(): LoggedResult[] {
    if (!existsSync(this.file)) return [];
    const out: LoggedResult[] = [];
    for (const l of readFileSync(this.file, "utf8").split("\n")) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
    }
    return out;
  }

  get(jobId: string, call: number): LoggedResult | undefined {
    return this.all().find((e) => e.job_id === jobId && e.call === call);
  }

  /** Term search: every term must occur (case-insensitive) in the tool name, input or result. */
  search(query: string, opts: { job_id?: string; tool?: string; limit?: number } = {}): SearchHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    const hits: { score: number; hit: SearchHit }[] = [];
    for (const e of this.all()) {
      if (opts.job_id && e.job_id !== opts.job_id) continue;
      if (opts.tool && e.tool.toLowerCase() !== String(opts.tool).toLowerCase()) continue;
      const resultText = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
      const hay = `${e.tool} ${JSON.stringify(e.input)} ${resultText}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const at = terms.length ? resultText.toLowerCase().indexOf(terms[0]!) : 0;
      const from = Math.max(0, at - 60);
      const snippet = (at >= 0 ? resultText.slice(from, from + SNIPPET) : resultText.slice(0, SNIPPET)).replace(/\s+/g, " ");
      hits.push({ score: terms.reduce((n, t) => n + hay.split(t).length - 1, 0), hit: { job_id: e.job_id, call: e.call, tool: e.tool, snippet } });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map((h) => h.hit);
  }
}
