// gitRepo {owner?, repoName} for initialize_session / load_session results (spec 3.1.5), from the origin remote.

export interface GitRepoInfo { owner?: string; repoName: string }

/** Parses https://host/owner/repo(.git), ssh://git@host/owner/repo, git@host:owner/repo.git and file paths. */
export function parseRemoteUrl(url: string): GitRepoInfo | undefined {
  const u = url.trim().replace(/\/+$/, "");
  if (!u) return undefined;
  let rest: string;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(u);
  if (scp) rest = scp[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { rest = new URL(u).pathname.replace(/^\/+/, ""); } catch { return undefined; }
  } else rest = u;
  const parts = rest.replace(/\.git$/i, "").split("/").filter(Boolean);
  const repoName = parts[parts.length - 1];
  if (!repoName) return undefined;
  const owner = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return { ...(owner ? { owner } : {}), repoName };
}

/** The origin remote of the repository at cwd, or undefined (no git, no repository, no origin). */
export function gitRepoOf(cwd: string): GitRepoInfo | undefined {
  try {
    const r = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    if (r.exitCode !== 0) return undefined;
    return parseRemoteUrl(r.stdout.toString());
  } catch {
    return undefined;
  }
}
