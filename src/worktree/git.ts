import { realpathSync } from "node:fs";
import path from "node:path";
// Non-interactive git runner for the worktree manager (spec §18.2: LC_ALL=C, no prompts, timeout).
export interface GitResult { code: number; stdout: string; stderr: string; timedOut: boolean }

export const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

export async function git(cwd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(opts.env ?? {}) },
  });
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

/** Runs git and throws with its stderr on failure. Returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed${r.timedOut ? " (timed out)" : ""}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

/**
 * The real path of a folder, falling back to the resolved path when it does not exist.
 * git always reports real paths (macOS /var/folders is /private/var/folders), so every
 * path used as a key or compared with git output goes through here first.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try { return realpathSync.native(abs); } catch { return abs; }
}

export async function repoTopLevel(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Absolute path of the worktree's own git dir (where the receipt lives). */
export async function gitDirOf(cwd: string): Promise<string> {
  return await gitOk(cwd, ["rev-parse", "--absolute-git-dir"]);
}
