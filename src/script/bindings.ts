// Turns a direct tool's text output into the structured data a Script sees (spec S1).
import type { ToolOutput } from "../core/types.ts";
import { resolvePath } from "../tools/util.ts";

export class ToolCallError extends Error {
  constructor(message: string, public errorName = "Error") {
    super(message);
  }
}

const BRACKET = /^\[(Results cut|Some paths|Showing|Lines )/;

function readResult(input: Record<string, unknown>, content: string, cwd: string) {
  const path = resolvePath(String(input.path ?? ""), cwd);
  if (/ is empty \(0 lines\)\.$/.test(content)) {
    return { path, text: "", startLine: 1, endLine: 0, totalLines: 0, truncated: false };
  }
  const k = content.lastIndexOf("\n[Lines ");
  const footer = k >= 0 ? content.slice(k + 1) : "";
  const text = k >= 0 ? content.slice(0, k) : content;
  const m = /^\[Lines (\d+)-(\d+) of (\d+)\./.exec(footer);
  return {
    path, text,
    startLine: m ? Number(m[1]) : 1, endLine: m ? Number(m[2]) : 0, totalLines: m ? Number(m[3]) : 0,
    truncated: /More lines remain/.test(footer),
  };
}

function grepResult(input: Record<string, unknown>, content: string) {
  const mode = typeof input.output === "string" ? input.output : "files";
  if (content === "No matches found.") return mode === "files" ? { files: [], truncated: false } : { files: [], matches: [], counts: {}, truncated: false };
  const lines = content.split("\n");
  const truncated = lines.some((l) => /^\[Results cut/.test(l));
  const body = lines.filter((l) => !BRACKET.test(l) && l !== "--");
  if (mode === "files") return { files: body.filter(Boolean), truncated };
  if (mode === "count") {
    const counts: Record<string, number> = {};
    for (const l of body) {
      const m = /^(.*):(\d+)$/.exec(l);
      if (m) counts[m[1]!] = Number(m[2]);
    }
    return { files: Object.keys(counts), counts, truncated };
  }
  const matches: { path: string; line: number; text: string; context?: boolean }[] = [];
  for (const l of body) {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    if (m) { matches.push({ path: m[1]!, line: Number(m[2]), text: m[3]! }); continue; }
    const c = /^(.*?)-(\d+)-(.*)$/.exec(l);
    if (c) matches.push({ path: c[1]!, line: Number(c[2]), text: c[3]!, context: true });
  }
  return { files: [...new Set(matches.map((x) => x.path))], matches, truncated };
}

function globResult(content: string) {
  if (content === "No files matched.") return { files: [], truncated: false };
  const lines = content.split("\n");
  return { files: lines.filter((l) => l && !BRACKET.test(l)), truncated: lines.some((l) => /^\[Showing/.test(l)) };
}

/** Structured value for a successful call; throws ToolCallError for a failed one. */
export function structure(tool: string, input: Record<string, unknown>, out: ToolOutput, cwd: string): unknown {
  if (out.data !== undefined) return out.data;
  if (out.isError) throw new ToolCallError(out.content);
  switch (tool) {
    case "Read": return readResult(input, out.content, cwd);
    case "Grep": return grepResult(input, out.content);
    case "Glob": return globResult(out.content);
    case "Edit": case "Create":
      try { return JSON.parse(out.content); } catch { return { text: out.content }; }
    default: {
      try { return JSON.parse(out.content); } catch { return { text: out.content }; }
    }
  }
}
