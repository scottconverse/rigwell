// `.worktreeinclude` (spec §18.3): gitignored files copied into a new worktree.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { git } from "./git.ts";

export const MAX_INCLUDE_BYTES = 64 * 1024;
export const MAX_INCLUDE_LINES = 500;

/** Parses the file text into relative paths. Throws when over the limits. */
export function parseWorktreeInclude(text: string): string[] {
  if (Buffer.byteLength(text) > MAX_INCLUDE_BYTES) throw new Error(".worktreeinclude is larger than 64 KB");
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_INCLUDE_LINES) throw new Error(".worktreeinclude has more than 500 lines");
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    if (path.isAbsolute(l) || l.split(/[\\/]/).includes("..")) continue; // inside the repo only
    out.push(l.replace(/^\.\//, "").replace(/\/+$/, ""));
  }
  return out;
}

export interface IncludeResult { copied: string[]; skipped: { path: string; reason: string }[] }

/** Copies listed files. Only paths `git check-ignore` confirms; skips symlinks; never overwrites; refuses real paths outside the repo. */
export async function copyWorktreeIncludes(repoRoot: string, worktree: string): Promise<IncludeResult> {
  const result: IncludeResult = { copied: [], skipped: [] };
  const file = path.join(repoRoot, ".worktreeinclude");
  if (!existsSync(file)) return result;
  const entries = parseWorktreeInclude(readFileSync(file, "utf8"));
  const realRepo = realpathSync(repoRoot);
  for (const rel of entries) {
    const src = path.join(repoRoot, rel);
    const skip = (reason: string) => result.skipped.push({ path: rel, reason });
    let st;
    try { st = lstatSync(src); } catch { skip("missing"); continue; }
    if (st.isSymbolicLink()) { skip("symlink"); continue; }
    const real = realpathSync(src);
    if (real !== realRepo && !real.startsWith(realRepo + path.sep)) { skip("outside repo"); continue; }
    const ig = await git(repoRoot, ["check-ignore", "-q", "--", rel]);
    if (ig.code !== 0) { skip("not gitignored"); continue; }
    const files = st.isDirectory() ? listFiles(src, rel) : [rel];
    for (const f of files) {
      const from = path.join(repoRoot, f);
      const fst = lstatSync(from);
      if (fst.isSymbolicLink() || !fst.isFile()) continue;
      const to = path.join(worktree, f);
      if (existsSync(to)) { result.skipped.push({ path: f, reason: "exists" }); continue; }
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      result.copied.push(f);
    }
  }
  return result;
}

function listFiles(abs: string, rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(path.join(abs, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
