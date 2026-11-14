import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { git, gitOk, repoTopLevel } from "../worktree/git.ts";
import { semanticDiff, type ReviewSource } from "./semantic.ts";

export interface DiffLine { kind: "context" | "added" | "removed" | "hunk"; text: string; oldLine?: number; newLine?: number }
export interface ReviewFile extends ReviewSource { status: string; binary: boolean; lines: DiffLine[]; warning?: string }
export interface ReviewComment { path: string; side: "old" | "new"; line: number; body: string }
export interface ReviewSnapshot {
  id: string; cwd: string; mode: "branch" | "pr"; base: string; head: string; files: ReviewFile[];
  semantic: Awaited<ReturnType<typeof semanticDiff>>;
  comments: { path?: string; line?: number; side?: string; body: string; author?: string; url?: string }[];
  checks: { name: string; state: string }[];
  pr?: { provider: "github" | "gitlab"; project: string; number: number; url: string; title: string; state: string; start?: string };
}

export function diffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = []; let old = 0, next = 0, inHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; lines.push({ kind: "hunk", text }); continue; }
    if (!inHunk) continue;
    if (text.startsWith("+")) lines.push({ kind: "added", text: text.slice(1), newLine: next++ });
    else if (text.startsWith("-")) lines.push({ kind: "removed", text: text.slice(1), oldLine: old++ });
    else if (text.startsWith(" ")) lines.push({ kind: "context", text: text.slice(1), oldLine: old++, newLine: next++ });
  }
  return lines;
}

const maxSnapshot = 16 * 1024 * 1024;
async function committed(cwd: string, ref: string, path: string) {
  const result = await git(cwd, ["show", `${ref}:${path}`]);
  if (result.code !== 0) throw new Error(`Cannot read the review base for ${path}`);
  return result.stdout;
}
function current(cwd: string, path: string) {
  const target = resolve(cwd, path), rel = relative(cwd, target);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Review file escapes the repository");
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return readlinkSync(target);
  const actual = relative(realpathSync.native(cwd), realpathSync.native(target));
  if (isAbsolute(actual) || actual.startsWith("..")) throw new Error("Review file resolves outside the repository");
  if (stat.size > maxSnapshot) throw new Error(`Review file exceeds 16 MiB: ${path}`);
  return readFileSync(target, "utf8");
}

/** A read-only comparison of the branch and current index/worktree against its merge base. */
export async function localReview(folder: string, requestedBase?: string): Promise<ReviewSnapshot> {
  const cwd = await repoTopLevel(folder); if (!cwd) throw new Error("Review requires a Git repository");
  const head = await gitOk(cwd, ["rev-parse", "--verify", "HEAD"]);
  let ref = requestedBase;
  if (!ref) {
    for (const candidate of ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master", "HEAD"]) {
      if ((await git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])).code === 0) { ref = candidate; break; }
    }
  }
  const resolved = await gitOk(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const base = await gitOk(cwd, ["merge-base", head, resolved]);
  const raw = await git(cwd, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", base, "--"]);
  if (raw.code !== 0) throw new Error("Cannot list review changes");
  const names = raw.stdout.split("\0").filter(Boolean), entries: { path: string; oldPath?: string; status: string }[] = [];
  for (let i = 0; i < names.length;) {
    const status = names[i++]!, first = names[i++]!;
    entries.push(status.startsWith("R") || status.startsWith("C") ? { path: names[i++]!, oldPath: first, status: status[0]! } : { path: first, status: status[0]! });
  }
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) throw new Error("Cannot list untracked review files");
  for (const path of untracked.stdout.split("\0").filter(Boolean)) entries.push({ path, status: "A" });
  const files: ReviewFile[] = []; let bytes = 0;
  for (const entry of entries) {
    const before = entry.status === "A" ? "" : await committed(cwd, base, entry.oldPath ?? entry.path);
    const after = entry.status === "D" ? "" : current(cwd, entry.path);
    bytes += Buffer.byteLength(before) + Buffer.byteLength(after);
    if (bytes > maxSnapshot) throw new Error("Review snapshot exceeds 16 MiB; review a smaller change");
    const binary = before.includes("\0") || after.includes("\0");
    let lines: DiffLine[] = [];
    if (!binary) {
      if (entry.status === "A") lines = after.split("\n").map((text, index) => ({ kind: "added", text, newLine: index + 1 }));
      else {
        const patch = await git(cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color", "--unified=3", "-M", base, "--", ...new Set([entry.path, entry.oldPath].filter((p): p is string => !!p))]);
        if (patch.code !== 0) throw new Error(`Cannot load diff for ${entry.path}`);
        lines = diffLines(patch.stdout);
      }
    }
    files.push({ ...entry, before: binary ? "" : before, after: binary ? "" : after, binary, lines });
  }
  return { id: crypto.randomUUID(), mode: "branch", cwd, head, base, files, semantic: await semanticDiff(files.filter((f) => !f.binary)), comments: [], checks: [] };
}

export function reviewComments(snapshot: ReviewSnapshot, input: unknown): ReviewComment[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("comments must be an array of up to 100 line comments");
  return input.map((item) => {
    if (!item || typeof item.path !== "string" || !["old", "new"].includes(item.side) || !Number.isInteger(item.line) || item.line < 1 || typeof item.body !== "string" || !item.body.trim() || item.body.length > 65536) throw new Error("Each comment needs path, side, positive line and a nonempty body up to 64 KiB");
    const file = snapshot.files.find((f) => f.path === item.path);
    if (!file || file.binary || item.line > (item.side === "old" ? file.before : file.after).split("\n").length) throw new Error("Comment line is outside this review snapshot");
    return { path: item.path, side: item.side, line: item.line, body: item.body.trim() };
  });
}

export function addressReview(snapshot: ReviewSnapshot, comments: ReviewComment[]): string {
  if (!comments.length) throw new Error("Add at least one review comment to address");
  return [`Address these review comments in ${snapshot.cwd}.`, `Review base: ${snapshot.base}; head: ${snapshot.head}. Check the current files before making changes.`, "", ...comments.map((c, i) => `${i + 1}. ${JSON.stringify(c.path)}:${c.line} (${c.side === "old" ? "before" : "after"})\n${c.body}`)].join("\n");
}
