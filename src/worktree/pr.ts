// Pull requests for a checkout. Every push is preceded by an explicit user approval.
import { randomUUID } from "node:crypto";
import { defaultCredentialStore } from "../storage/credentials.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { git, gitOk } from "./git.ts";

export interface CodeRepo { provider: "github" | "gitlab"; project: string; host: string }
export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  url?: string;
  number?: number;
  checks: { name: string; state: string }[];
}
export interface PrInput { title?: string; body?: string; base?: string; draft?: boolean }
export interface PrDeps {
  which?: (name: string) => string | null;
  run?: (cmd: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  token?: (provider: string) => string | undefined;
  fetch?: typeof fetch;
  /** Test seam: never supplied by protocol input. */
  apiRoot?: (repo: CodeRepo) => string;
  repo?: (remote: string) => CodeRepo | null;
}
export type ApprovePr = (params: Record<string, unknown>) => Promise<unknown>;

export function codeRepo(remote: string): CodeRepo | null {
  const normalized = remote.replace(/^git@([^:]+):/, "https://$1/");
  let url: URL;
  try { url = new URL(normalized); } catch { return null; }
  if (!["https:", "ssh:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
  const project = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return provider && project.split("/").length >= 2 ? { provider, project, host } : null;
}

async function run(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

async function checkout(cwd: string, d: PrDeps) {
  const branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!branch) throw new Error("A branch is required; this checkout has a detached HEAD");
  const remote = (await git(cwd, ["remote", "get-url", "--push", "origin"])).stdout.trim();
  return { branch, remote, repo: (d.repo ?? codeRepo)(remote), sha: await gitOk(cwd, ["rev-parse", "HEAD"]) };
}

function cli(repo: CodeRepo, d: PrDeps) { return (d.which ?? Bun.which)(repo.provider === "github" ? "gh" : "glab"); }
async function command(cmd: string[], cwd: string, d: PrDeps) {
  const r = await (d.run ?? run)(cmd, cwd);
  if (r.code !== 0) throw new Error(`${cmd[0]} ${cmd[1]} failed: ${r.stderr.trim() || "command failed"}`);
  return r.stdout.trim();
}
async function api(repo: CodeRepo, route: string, d: PrDeps, body?: unknown): Promise<any> {
  const token = (d.token ?? ((p) => defaultCredentialStore().get(p)))(repo.provider);
  if (!token) throw new Error(`Connect ${repo.provider} or install and sign in with ${repo.provider === "github" ? "gh" : "glab"}`);
  const root = d.apiRoot?.(repo) ?? (repo.provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4");
  const r = await (d.fetch ?? fetch)(root + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`${repo.provider} API returned HTTP ${r.status}`);
  return r.json();
}
const endpoint = (r: CodeRepo) => r.provider === "github" ? `/repos/${r.project}` : `/projects/${encodeURIComponent(r.project)}`;
function status(raw: any, provider: CodeRepo["provider"]): PrStatus {
  const state = String(raw.state ?? "").toLowerCase();
  return {
    state: raw.merged_at || raw.merged || state === "merged" ? "merged" : state === "open" || state === "opened" ? "open" : "closed",
    url: raw.url?.startsWith("https://api.") ? raw.html_url : raw.web_url ?? raw.html_url ?? raw.url,
    number: Number(raw.number ?? raw.iid),
    checks: provider === "github" ? (raw.statusCheckRollup ?? []).map((c: any) => ({ name: c.name ?? c.context ?? "check", state: c.conclusion || c.state || c.status }))
      : raw.head_pipeline ? [{ name: "pipeline", state: raw.head_pipeline.status }] : [],
  };
}

export async function getPrStatus(cwd: string, d: PrDeps = {}): Promise<PrStatus> {
  const remote = (await git(cwd, ["remote", "get-url", "--push", "origin"])).stdout.trim();
  const r = (d.repo ?? codeRepo)(remote);
  if (!r) return { state: "none", checks: [] };
  const branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!branch) return { state: "none", checks: [] };
  const c = { branch }, tool = cli(r, d);
  if (tool) {
    // Listing returns [] for a branch without a PR, rather than conflating it with an auth failure.
    const args = r.provider === "github"
      ? [tool, "pr", "list", "--repo", r.project, "--head", c.branch, "--state", "open", "--json", "number,url,state"]
      : [tool, "mr", "list", "--repo", r.project, "--source-branch", c.branch, "--output", "json"];
    let rows = JSON.parse(await command(args, cwd, d));
    if (!rows.length) {
      const all = [...args];
      if (r.provider === "github") all[all.indexOf("--state") + 1] = "all"; else all.push("--all");
      rows = JSON.parse(await command(all, cwd, d));
    }
    const row = rows.find((x: any) => /^(open|opened)$/i.test(x.state)) ?? rows[0];
    if (!row) return { state: "none", checks: [] };
    const detail = r.provider === "github"
      ? [tool, "pr", "view", String(row.number), "--repo", r.project, "--json", "number,url,state,statusCheckRollup"]
      : [tool, "mr", "view", String(row.iid), "--repo", r.project, "--output", "json"];
    return status(JSON.parse(await command(detail, cwd, d)), r.provider);
  }
  const root = endpoint(r);
  const route = r.provider === "github" ? `${root}/pulls?state=open&head=${encodeURIComponent(r.project.split("/")[0] + ":" + c.branch)}` : `${root}/merge_requests?state=opened&source_branch=${encodeURIComponent(c.branch)}`;
  let rows = await api(r, route, d);
  if (!rows.length) rows = await api(r, route.replace(/state=(?:open|opened)&/, "state=all&"), d);
  const row = rows.find((x: any) => /^(open|opened)$/.test(x.state)) ?? rows[0];
  if (!row) return { state: "none", checks: [] };
  const detail = await api(r, `${root}/${r.provider === "github" ? "pulls/" + row.number : "merge_requests/" + row.iid}`, d);
  const result = status(detail, r.provider);
  if (r.provider === "github") {
    const sha = encodeURIComponent(detail.head.sha);
    const [checks, states] = await Promise.all([api(r, `${root}/commits/${sha}/check-runs`, d), api(r, `${root}/commits/${sha}/status`, d)]);
    result.checks = [...checks.check_runs.map((x: any) => ({ name: x.name, state: x.conclusion || x.status })), ...states.statuses.map((x: any) => ({ name: x.context, state: x.state }))];
  }
  return result;
}

export async function createPr(cwd: string, input: PrInput, approve?: ApprovePr, d: PrDeps = {}): Promise<{ url: string; number: number }> {
  if (!approve) throw new RpcError(ErrorCodes.REQUEST_CANCELLED, "Creating a PR requires an interactive approver");
  const c = await checkout(cwd, d);
  if (!c.repo) throw new Error("Origin must be a GitHub or GitLab repository");
  const tool = cli(c.repo, d);
  if (!tool) {
    const token = (d.token ?? ((p) => defaultCredentialStore().get(p)))(c.repo.provider);
    if (!token) throw new Error(`Connect ${c.repo.provider} before pushing a PR branch`);
    d = { ...d, token: () => token };
  }
  const base = input.base ?? ((await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "") || "main");
  const title = input.title?.trim() || c.branch, body = input.body ?? "", draft = input.draft === true;
  const details = { branch: c.branch, base, title, body, draft, repository: `${c.repo.host}/${c.repo.project}` };
  const answer = await approve({ toolUses: [{ toolUse: { type: "tool_use", id: randomUUID(), name: "create_pr", input: details }, confirmationType: "create_pr", details }], options: [{ label: "Push branch and create PR", value: "proceed_once" }, { label: "Cancel", value: "cancel" }] }) as any;
  if (answer?.selectedOption !== "proceed_once") throw new RpcError(ErrorCodes.REQUEST_CANCELLED, "PR creation cancelled; nothing was pushed");
  const after = await checkout(cwd, d);
  if (after.branch !== c.branch || after.sha !== c.sha || after.remote !== c.remote) throw new Error("Checkout changed during approval; request approval again");
  await gitOk(cwd, ["push", "-u", "origin", c.branch], { timeoutMs: 5 * 60_000 });
  const r = c.repo;
  try {
  if (tool) {
    const args = r.provider === "github" ? [tool, "pr", "create", "--repo", r.project, "--head", c.branch, "--base", base, "--title", title, "--body", body, ...(draft ? ["--draft"] : [])]
      : [tool, "mr", "create", "--repo", r.project, "--source-branch", c.branch, "--target-branch", base, "--title", title, "--description", body, "--yes", "--no-editor", "--push=false", "--remove-source-branch=false", ...(draft ? ["--draft"] : [])];
    const out = await command(args, cwd, d);
    const url = out.match(/https:\/\/[^\s]+\/(?:pull|merge_requests)\/\d+/)?.[0];
    if (!url) throw new Error("Branch pushed, but the CLI did not return a PR URL; check PR status before retrying");
    return { url, number: Number(url.split("/").at(-1)) };
  }
  const raw = await api(r, `${endpoint(r)}/${r.provider === "github" ? "pulls" : "merge_requests"}`, d,
    r.provider === "github" ? { title, body, base, head: c.branch, draft } : { title: draft ? `Draft: ${title}` : title, description: body, target_branch: base, source_branch: c.branch });
  return { url: raw.html_url ?? raw.web_url, number: raw.number ?? raw.iid };
  } catch (e) {
    throw new Error(`Branch ${c.branch} was pushed; PR creation did not finish. Check PR status before retrying. ${(e as Error).message}`);
  }
}
