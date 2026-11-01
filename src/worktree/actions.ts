// Git actions for a session's checkout (spec §18.6). create_pr and PR status are not built.
import { git, gitOk } from "./git.ts";

export async function listBranches(cwd: string): Promise<{ current: string | null; local: string[]; remote: string[] }> {
  const current = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
  const refs = async (pattern: string) =>
    (await gitOk(cwd, ["for-each-ref", "--format=%(refname:short)", pattern])).split("\n").filter((b) => b && !b.endsWith("/HEAD"));
  return { current, local: await refs("refs/heads"), remote: await refs("refs/remotes") };
}

async function changedFiles(cwd: string): Promise<string[]> {
  const out = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  return out.split("\0").filter(Boolean).map((e) => e.slice(3));
}

export type CheckoutResult =
  | { ok: true; branch: string }
  | { ok: false; needsResolution: true; changedFiles: string[] };

/** Switches branch. A dirty tree returns needs_resolution unless `resolve` says to stash or commit first. */
export async function checkoutBranch(cwd: string, branch: string, resolve?: { mode: "stash" | "commit"; message?: string }): Promise<CheckoutResult> {
  const files = await changedFiles(cwd);
  if (files.length > 0) {
    if (!resolve) return { ok: false, needsResolution: true, changedFiles: files };
    if (resolve.mode === "stash") await gitOk(cwd, ["stash", "push", "-u", "-m", `rigwell: before checkout of ${branch}`]);
    else await commit(cwd, resolve.message ?? `WIP before checkout of ${branch}`);
  }
  await gitOk(cwd, ["checkout", branch]);
  return { ok: true, branch };
}

/** Stages everything and commits. Returns the new head SHA. */
export async function commit(cwd: string, message: string): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error("A commit message is required");
  await gitOk(cwd, ["add", "-A"]);
  await gitOk(cwd, ["commit", "-m", message]);
  return { sha: await gitOk(cwd, ["rev-parse", "HEAD"]) };
}

/** Pushes the current branch to origin (setting upstream). The branch is never merged back automatically. */
export async function push(cwd: string): Promise<{ branch: string; remote: string }> {
  const branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!branch) throw new Error("Detached HEAD: nothing to push");
  const remote = (await gitOk(cwd, ["remote"])).split("\n")[0];
  if (!remote) throw new Error("No git remote configured");
  await gitOk(cwd, ["push", "-u", remote, branch], { timeoutMs: 5 * 60_000 });
  return { branch, remote };
}
