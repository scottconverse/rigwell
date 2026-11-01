import * as fs from "node:fs";
import * as path from "node:path";
import type { FileReadRecord, ToolContext, ToolOutput } from "../core/types.ts";

export function ok(content: string): ToolOutput {
  return { content };
}

export function fail(content: string): ToolOutput {
  return { content, isError: true };
}

export function resolvePath(p: string, cwd: string): string {
  let q = p;
  if (q === "~" || q.startsWith("~/")) q = (process.env.HOME ?? "") + q.slice(1);
  return path.resolve(cwd, q);
}

export function strArg(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

export function intArg(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

export function boolArg(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

export function recordOf(st: fs.Stats): FileReadRecord {
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** Number of lines in a text; a single trailing newline does not add a line. */
export function countLines(s: string): number {
  if (s === "") return 0;
  const t = s.endsWith("\n") ? s.slice(0, -1) : s;
  return t.split("\n").length;
}

export function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const err = e as NodeJS.ErrnoException;
    return `${err.code}: ${err.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Checks the read-before-write rule. Returns an error message, or null when the
 * session has read the file and it has not changed since.
 */
export function checkFresh(abs: string, st: fs.Stats, ctx: ToolContext): string | null {
  const rec = ctx.readFiles.get(abs);
  if (!rec) {
    return `${abs} has not been read in this session. Read it first, then try again.`;
  }
  if (rec.mtimeMs !== st.mtimeMs || rec.size !== st.size) {
    return `${abs} changed since you read it. Read it again, then try again.`;
  }
  return null;
}

import { PROMPT_TEXT } from "../agent/prompt-text.generated.ts";

type PromptKey = keyof typeof PROMPT_TEXT;

/** Tool description from the spec text, with {{PLACEHOLDER}} values filled in. */
export function promptDesc(tool: string, vars: Record<string, string> = {}): string {
  let s = PROMPT_TEXT[`tool_${tool}_desc` as PromptKey] as string;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(v);
  return s;
}

export function promptSchema(tool: string): Record<string, any> {
  return JSON.parse(PROMPT_TEXT[`tool_${tool}_schema` as PromptKey] as string);
}
