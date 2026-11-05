// Pull requests for a session's worktree branch (spec 18.6, owner approved): create_pr and PR status.
// The `gh` CLI is used when it is installed. Without it, the GitHub REST API is used with the token stored in the
// credential store under the name "github". Nothing here merges anything.
// Test and enterprise knobs: RIGWELL_GH_CMD (a JSON array that replaces the `gh` command; "[]" means no gh) and
// RIGWELL_GITHUB_API (the REST API base URL, default https://api.github.com).
import { lookupCredential } from "../storage/credentials.ts";
import { git, gitOk } from "./git.ts";
import { push } from "./actions.ts";

export const GITHUB_CREDENTIAL = "github";

export interface PrDeps {
  /** The gh command (e.g. ["gh"]), or null when gh is not available. */
  gh?: string[] | null;
  token?: () => string | undefined;
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface PrPlan { branch: string; base: string; remote: string; title: string; body: string; draft: boolean }
export type PrCreated = { created: true; url: string; number: number; branch: string; base: string; via: "gh" | "api" };
export type PrCancelled = { created: false; cancelled: true };

export type CheckSummary = { total: number; passed: number; failed: number; pending: number; state: "none" | "passing" | "failing" | "pending" };
export type PrStatus =
  | { state: "none"; branch: string }
  | { state: "open" | "merged" | "closed"; branch: string; number: number; url: string; draft: boolean; checks: CheckSummary };

/** No way to reach GitHub: gh is missing and no token is stored. */
export class PrUnavailable extends Error {}

function ghFromEnv(): string[] | null {
  const raw = process.env.RIGWELL_GH_CMD;
  if (raw !== undefined) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.every((x) => typeof x === "string")) return a.length ? a : null;
    } catch { /* fall through to the error */ }
    throw new Error("RIGWELL_GH_CMD must be a JSON array of strings");
  }
  const bin = Bun.which("gh");
  return bin ? [bin] : null;
}

function resolveDeps(d: PrDeps = {}) {
  return {
    gh: d.gh !== undefined ? d.gh : ghFromEnv(),
    token: d.token ?? (() => lookupCredential(GITHUB_CREDENTIAL)),
    apiBase: (d.apiBase ?? process.env.RIGWELL_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, ""),
    fetch: d.fetch ?? fetch,
  };
}

async function run(cmd: string[], cwd: string, timeoutMs = 2 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function currentBranch(cwd: string): Promise<string> {
  const b = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!b) throw new Error("Detached HEAD: check out a branch first");
  return b;
}

async function firstRemote(cwd: string): Promise<string> {
  const remotes = (await gitOk(cwd, ["remote"])).split("\n").filter(Boolean);
  if (!remotes.length) throw new Error("No git remote configured");
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/** "owner/repo" from the last two path parts of a remote URL (https, ssh, scp-like or a local path). */
export function repoSlug(url: string): { owner: string; repo: string } | null {
  const parts = url.trim().replace(/\\/g, "/").replace(/\.git\/?$/, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

/** What the confirmation shows. `fallbackBase` is the worktree's recorded base branch. */
export async function planPr(cwd: string, req: { title?: string; body?: string; base?: string; draft?: boolean }, fallbackBase?: string): Promise<PrPlan> {
  const branch = await currentBranch(cwd);
  const remote = await firstRemote(cwd);
  let base = req.base?.trim();
  if (!base) {
    const head = (await git(cwd, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`])).stdout.trim();
    base = head ? head.slice(remote.length + 1) : fallbackBase && fallbackBase !== branch ? fallbackBase : "main";
  }
  if (base === branch) throw new Error(`The branch ${branch} is the base branch; a pull request needs a different base`);
  // A pull request holds only commits. Refuse a branch with no commits past the base, before anything is asked or pushed.
  const baseRef = [`${remote}/${base}`, base];
  for (const ref of baseRef) {
    if ((await git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).code !== 0) continue;
    const ahead = Number((await git(cwd, ["rev-list", "--count", `${ref}..HEAD`])).stdout.trim());
    if (ahead === 0) {
      const dirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim() !== "";
      throw new Error(dirty
        ? `The branch ${branch} has edits that are not committed. Commit them first; a pull request holds only commits. Nothing was pushed.`
        : `The branch ${branch} has no commits that are not on ${base}. Nothing was pushed.`);
    }
    break;
  }
  const title = req.title?.trim() || (await git(cwd, ["log", "-1", "--format=%s"])).stdout.trim() || branch;
  let body = req.body;
  if (body === undefined) {
    const range = (await git(cwd, ["rev-parse", "--verify", "-q", `${remote}/${base}`])).code === 0 ? `${remote}/${base}..HEAD` : null;
    body = range ? (await git(cwd, ["log", "--reverse", "--format=- %s", range])).stdout.trim() : "";
  }
  return { branch, base, remote, title, body, draft: req.draft === true };
}

/** The request_permission params for a PR plan (confirmationType create_pr). */
export function prPermission(plan: PrPlan, requestId: string = crypto.randomUUID()) {
  const details = { branch: plan.branch, base: plan.base, remote: plan.remote, title: plan.title, body: plan.body, draft: plan.draft };
  return {
    requestId,
    toolUses: [{ toolUse: { type: "tool_use", id: requestId, name: "CreatePullRequest", input: details }, confirmationType: "create_pr", details }],
    options: [{ label: "Push and create the pull request", value: "proceed_once" }, { label: "Cancel", value: "cancel" }],
  };
}

/**
 * Asks first, then pushes the branch and opens the pull request. `approve` is the connection's request_permission;
 * without one (a headless run) this refuses and nothing is pushed. A cancel pushes nothing.
 */
export async function createPr(
  cwd: string, req: { title?: string; body?: string; base?: string; draft?: boolean },
  approve: ((params: Record<string, unknown>) => Promise<unknown>) | undefined,
  opts: { fallbackBase?: string; deps?: PrDeps } = {},
): Promise<PrCreated | PrCancelled> {
  if (!approve) throw new Error("create_pr needs a client that can approve it (an interactive session); nothing was pushed");
  const d = resolveDeps(opts.deps);
  const plan = await planPr(cwd, req, opts.fallbackBase);
  if (!d.gh && !d.token()) throw new PrUnavailable(`No way to reach GitHub: install the gh CLI or store a token as "${GITHUB_CREDENTIAL}"; nothing was pushed`);
  const answer = (await approve(prPermission(plan)).catch(() => undefined)) as { selectedOption?: string } | undefined;
  if (answer?.selectedOption !== "proceed_once") return { created: false, cancelled: true };
  await push(cwd);
  if (d.gh) {
    const args = ["pr", "create", "--head", plan.branch, "--base", plan.base, "--title", plan.title, "--body", plan.body, ...(plan.draft ? ["--draft"] : [])];
    const r = await run([...d.gh, ...args], cwd);
    if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout.trim().split(/\s+/).reverse().find((w) => /\/pull\/\d+/.test(w));
    if (!url) throw new Error(`gh pr create printed no pull request URL: ${r.stdout.trim()}`);
    return { created: true, url, number: Number(/\/pull\/(\d+)/.exec(url)![1]), branch: plan.branch, base: plan.base, via: "gh" };
  }
  const slug = await slugOf(cwd, plan.remote);
  const res = await api(d, "POST", `/repos/${slug.owner}/${slug.repo}/pulls`, { title: plan.title, body: plan.body, head: plan.branch, base: plan.base, draft: plan.draft });
  return { created: true, url: String(res.html_url), number: Number(res.number), branch: plan.branch, base: plan.base, via: "api" };
}

async function slugOf(cwd: string, remote: string) {
  const url = await gitOk(cwd, ["remote", "get-url", remote]);
  const s = repoSlug(url);
  if (!s) throw new Error(`Cannot tell the GitHub repository from the remote URL ${url}`);
  return s;
}

async function api(d: ReturnType<typeof resolveDeps>, method: string, p: string, body?: unknown): Promise<any> {
  const token = d.token();
  if (!token) throw new PrUnavailable(`No GitHub token: install the gh CLI or store a token as "${GITHUB_CREDENTIAL}"`);
  const r = await d.fetch(d.apiBase + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "rigwell", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = [j.message, ...(j.errors ?? []).map((e: any) => e.message ?? e.code)].filter(Boolean).join(": "); } catch { /* keep the text */ }
    throw new Error(`GitHub API ${method} ${p} failed (${r.status}): ${msg.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE", "STALE"]);

/** Counts checks. Each item is a check run ({status, conclusion}) or a commit status ({state}); either case. */
export function summarizeChecks(items: { status?: string | null; conclusion?: string | null; state?: string | null }[]): CheckSummary {
  let passed = 0, failed = 0, pending = 0;
  for (const it of items) {
    const done = it.state != null ? it.state.toUpperCase() : (it.status ?? "").toUpperCase() === "COMPLETED" ? (it.conclusion ?? "").toUpperCase() : "";
    if (PASSED.has(done)) passed++;
    else if (FAILED.has(done)) failed++;
    else pending++;
  }
  const total = passed + failed + pending;
  return { total, passed, failed, pending, state: total === 0 ? "none" : failed ? "failing" : pending ? "pending" : "passing" };
}

/** Open, merged or closed, with a checks summary; `none` when the branch has no pull request. */
export async function prStatus(cwd: string, deps?: PrDeps): Promise<PrStatus> {
  const d = resolveDeps(deps);
  const branch = await currentBranch(cwd);
  if (d.gh) {
    const r = await run([...d.gh, "pr", "view", branch, "--json", "number,url,state,isDraft,statusCheckRollup"], cwd);
    if (r.code !== 0) {
      if (/no (open )?pull requests? found/i.test(r.stderr + r.stdout)) return { state: "none", branch };
      throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const j = JSON.parse(r.stdout);
    const state = String(j.state).toLowerCase();
    return { state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open", branch, number: j.number, url: j.url, draft: j.isDraft === true, checks: summarizeChecks(j.statusCheckRollup ?? []) };
  }
  if (!d.token()) throw new PrUnavailable(`No way to reach GitHub: install the gh CLI or store a token as "${GITHUB_CREDENTIAL}"`);
  const slug = await slugOf(cwd, await firstRemote(cwd));
  const list = await api(d, "GET", `/repos/${slug.owner}/${slug.repo}/pulls?head=${encodeURIComponent(`${slug.owner}:${branch}`)}&state=all&per_page=1`);
  const pr = Array.isArray(list) ? list[0] : undefined;
  if (!pr) return { state: "none", branch };
  const sha = pr.head?.sha;
  const [runs, statuses] = sha
    ? await Promise.all([
        api(d, "GET", `/repos/${slug.owner}/${slug.repo}/commits/${sha}/check-runs?per_page=100`).then((x) => x.check_runs ?? [], () => []),
        api(d, "GET", `/repos/${slug.owner}/${slug.repo}/commits/${sha}/status`).then((x) => x.statuses ?? [], () => []),
      ])
    : [[], []];
  return {
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open", branch, number: pr.number, url: pr.html_url, draft: pr.draft === true,
    checks: summarizeChecks([...runs, ...statuses]),
  };
}

/**
 * For auto-delete (spec 18.5): does this worktree's branch have an open pull request? A branch with no upstream and no
 * recorded PR cannot have one, so it is not looked up. When GitHub cannot be reached at all, a recorded PR counts as
 * open (keep it) and anything else as none. Any other lookup error counts as open: an unknown answer keeps the worktree.
 */
export async function hasOpenPr(w: { path: string; pr?: { number: number; url: string } }, deps?: PrDeps): Promise<boolean> {
  const upstream = (await git(w.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).code === 0;
  if (!upstream && !w.pr) return false;
  try {
    return (await prStatus(w.path, deps)).state === "open";
  } catch (e) {
    return e instanceof PrUnavailable ? !!w.pr : true;
  }
}
