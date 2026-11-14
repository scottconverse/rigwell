import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createPr, getPrStatus, codeRepo, type PrDeps, type PrStatus } from "../../src/worktree/pr.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import { handleWorktreeMethod } from "../../src/worktree/connect.ts";
import { makeGitRepo, sh, tmp } from "./util.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";

let environment: ReturnType<typeof tmpEnv>;
beforeEach(() => { environment = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()])); });
afterEach(() => { setCredentialStore(undefined); environment.cleanup(); });

function fixture() {
  const repo = makeGitRepo(), bare = tmp("pr-bare");
  sh(bare, "init", "--bare", "-q", "-b", "main");
  sh(repo, "remote", "add", "origin", bare);
  sh(repo, "push", "-q", "origin", "main");
  sh(repo, "checkout", "-qb", "feature/pr");
  const published = () => { try { return execFileSync("git", ["rev-parse", "--verify", "refs/heads/feature/pr"], { cwd: bare, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const deps: PrDeps = { repo: () => ({ provider: "github", host: "github.com", project: "owner/repo" }), which: () => "fake-gh" };
  return { repo, bare, published, deps };
}
const approve = async () => ({ selectedOption: "proceed_once" });

test("provider parsing accepts SSH/HTTPS and does not mistake local remotes for hosted repos", () => {
  expect(codeRepo("git@github.com:owner/repo.git")).toEqual({ provider: "github", host: "github.com", project: "owner/repo" });
  expect(codeRepo("https://gitlab.com/group/sub/repo.git")?.project).toBe("group/sub/repo");
  expect(codeRepo("C:\\fixture\\bare")).toBeNull();
  expect(codeRepo("https://unrelated.example/a/b")).toBeNull();
});

test("headless, cancelled and invalid approvals never push or call the provider", async () => {
  const f = fixture();
  let calls = 0;
  f.deps.run = async () => { calls++; throw new Error("unexpected provider call"); };
  for (const answer of [undefined, async () => ({ selectedOption: "cancel" }), async () => ({ selectedOption: "proceed_always" })]) {
    const error = await createPr(f.repo, {}, answer, f.deps).then(() => null, (e) => e);
    expect(error.code).toBe(-32800);
    expect(f.published()).toBeNull();
  }
  expect(calls).toBe(0);
});

test("approval shows full content before local push and gh creates a draft PR", async () => {
  const f = fixture(), calls: string[][] = [];
  f.deps.run = async (cmd) => {
    expect(f.published()).toBe(sh(f.repo, "rev-parse", "HEAD"));
    calls.push(cmd); return { code: 0, stdout: "https://github.com/owner/repo/pull/7\n", stderr: "" };
  };
  const input = { title: "Add feature", body: "First line\nSecond line", base: "main", draft: true };
  const result = await createPr(f.repo, input, async (p: any) => {
    expect(f.published()).toBeNull();
    expect(p.toolUses[0].confirmationType).toBe("create_pr");
    expect(p.toolUses[0].details).toMatchObject({ ...input, branch: "feature/pr" });
    return approve();
  }, f.deps);
  expect(result).toEqual({ url: "https://github.com/owner/repo/pull/7", number: 7 });
  expect(calls[0]).toEqual(["fake-gh", "pr", "create", "--repo", "owner/repo", "--head", "feature/pr", "--base", "main", "--title", input.title, "--body", input.body, "--draft"]);
  expect(sh(f.repo, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/pr");
});

test("changing the checkout during approval invalidates that approval", async () => {
  const f = fixture();
  const error = await createPr(f.repo, {}, async () => { sh(f.repo, "checkout", "-qb", "different"); return approve(); }, f.deps).then(() => null, (e) => e);
  expect(error.message).toContain("changed during approval");
  expect(f.published()).toBeNull();
});

test("missing API credentials fail before any push", async () => {
  const f = fixture(); f.deps.which = () => null; f.deps.token = () => undefined;
  const error = await createPr(f.repo, {}, approve, f.deps).then(() => null, (e) => e);
  expect(error.message).toContain("before pushing"); expect(f.published()).toBeNull();
});

test("protocol methods validate inputs and refuse creation without an approver", async () => {
  const f = fixture(), ctx = { cwd: f.repo, settings: () => ({}) };
  expect(await handleWorktreeMethod("get_pr_status", {}, ctx)).toEqual({ handled: true, result: { state: "none", checks: [] } });
  const invalid = await handleWorktreeMethod("create_pr", { draft: "yes" }, ctx).then(() => null, (e) => e);
  expect(invalid.code).toBe(-32602);
  const refused = await handleWorktreeMethod("create_pr", {}, ctx).then(() => null, (e) => e);
  expect(refused.code).toBe(-32800); expect(f.published()).toBeNull();
});

test("provider failure reports that the branch was already pushed", async () => {
  const f = fixture(); f.deps.run = async () => ({ code: 1, stdout: "", stderr: "fake service unavailable" });
  const error = await createPr(f.repo, {}, approve, f.deps).then(() => null, (e) => e);
  expect(error.message).toContain("was pushed"); expect(error.message).toContain("Check PR status before retrying");
  expect(f.published()).not.toBeNull();
});

test("the real CLI subprocess runner executes a fake gh script after local push", async () => {
  const f = fixture();
  // Bun runs the local script named pr; subsequent argv are the same gh subcommands/options.
  writeFileSync(join(f.repo, "pr"), 'if (process.argv[2] !== "create" || !process.argv.includes("--body")) process.exit(2); if (process.env.GH_TOKEN !== "fixture-cli-token" || process.env.GH_HOST !== "github.com" || process.argv.includes("fixture-cli-token")) process.exit(3); console.log("https://github.com/owner/repo/pull/11");');
  f.deps.which = () => process.execPath;
  f.deps.token = async () => "fixture-cli-token";
  expect(await createPr(f.repo, { body: "one\ntwo" }, approve, f.deps)).toEqual({ url: "https://github.com/owner/repo/pull/11", number: 11 });
  expect(f.published()).not.toBeNull();
});

test("GitLab CLI gets source, target and multiline description", async () => {
  const f = fixture();
  f.deps.repo = () => ({ provider: "gitlab", host: "gitlab.com", project: "group/repo" });
  f.deps.which = () => "fake-glab";
  f.deps.token = async () => "fixture-gitlab-token";
  f.deps.run = async (cmd, _cwd, env) => {
    expect(cmd.slice(0, 3)).toEqual(["fake-glab", "mr", "create"]);
    expect(cmd).toContain("--target-branch"); expect(cmd).toContain("--description"); expect(cmd).toContain("--yes");
    expect(env).toMatchObject({ GITLAB_TOKEN: "fixture-gitlab-token", GITLAB_HOST: "gitlab.com" }); expect(cmd).not.toContain("fixture-gitlab-token");
    return { code: 0, stdout: "https://gitlab.com/group/repo/-/merge_requests/8", stderr: "" };
  };
  expect((await createPr(f.repo, { base: "main", body: "one\ntwo" }, approve, f.deps)).number).toBe(8);
});

test("gh status distinguishes no PR, open, merged and closed and includes checks", async () => {
  const f = fixture();
  for (const state of ["none", "OPEN", "MERGED", "CLOSED"]) {
    f.deps.run = async (cmd) => ({ code: 0, stderr: "", stdout: JSON.stringify(cmd[2] === "list" ? state === "none" ? [] : [{ number: 7, state }] : { number: 7, url: "https://github.com/owner/repo/pull/7", state, statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }] }) });
    const result = await getPrStatus(f.repo, f.deps);
    expect(result.state).toBe(state.toLowerCase() as any);
    if (state !== "none") expect(result.checks).toEqual([{ name: "test", state: "SUCCESS" }]);
  }
  f.deps.run = async () => ({ code: 1, stdout: "", stderr: "authentication failed" });
  const error = await getPrStatus(f.repo, f.deps).then(() => null, (e) => e);
  expect(error.message).toContain("authentication failed");
});

test("API fallback uses the stored token with a fake local server and reports checks", async () => {
  const f = fixture(), requests: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer fake-provider-token");
    const route = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json() : undefined;
    requests.push({ route, body });
    if (body) { expect(f.published()).not.toBeNull(); return Response.json({ number: 9, html_url: "https://github.com/owner/repo/pull/9" }); }
    if (route.endsWith("check-runs")) return Response.json({ check_runs: [{ name: "test", conclusion: "success" }] });
    if (route.endsWith("status")) return Response.json({ statuses: [{ context: "build", state: "pending" }] });
    if (route.endsWith("/pulls")) return Response.json([{ number: 9, state: "open" }]);
    return Response.json({ number: 9, state: "open", html_url: "https://github.com/owner/repo/pull/9", head: { sha: "fake-sha" } });
  } });
  f.deps.which = () => null; f.deps.token = () => "fake-provider-token"; f.deps.apiRoot = () => `http://127.0.0.1:${server.port}`;
  try {
    expect((await createPr(f.repo, { title: "API", body: "body", base: "main", draft: true }, approve, f.deps)).number).toBe(9);
    expect(requests[0].body).toEqual({ title: "API", body: "body", base: "main", head: "feature/pr", draft: true });
    const s = await getPrStatus(f.repo, f.deps);
    expect(s.state).toBe("open"); expect(s.checks).toEqual([{ name: "test", state: "success" }, { name: "build", state: "pending" }]);
  } finally { server.stop(true); }
});

test("GitLab API fallback creates a draft and returns pipeline status", async () => {
  const f = fixture();
  f.deps.repo = () => ({ provider: "gitlab", host: "gitlab.com", project: "group/repo" });
  f.deps.which = () => null; f.deps.token = () => "fake-token";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer fake-token");
    if (req.method === "POST") {
      expect(await req.json()).toEqual({ title: "Draft: Title", description: "Body", target_branch: "main", source_branch: "feature/pr" });
      return Response.json({ iid: 12, web_url: "https://gitlab.com/group/repo/-/merge_requests/12" });
    }
    const row = { iid: 12, state: "opened", web_url: "https://gitlab.com/group/repo/-/merge_requests/12", head_pipeline: { status: "running" } };
    return Response.json(new URL(req.url).pathname.endsWith("/12") ? row : [row]);
  } });
  f.deps.apiRoot = () => `http://127.0.0.1:${server.port}`;
  try {
    expect((await createPr(f.repo, { title: "Title", body: "Body", base: "main", draft: true }, approve, f.deps)).number).toBe(12);
    expect(await getPrStatus(f.repo, f.deps)).toMatchObject({ state: "open", number: 12, checks: [{ name: "pipeline", state: "running" }] });
  } finally { server.stop(true); }
});

test("automatic and archive cleanup keep open PRs and unknown status, allow merged PRs", async () => {
  const repo = makeGitRepo(), root = tmp("pr-managed");
  let state: PrStatus["state"] | "error" = "open";
  const m = new WorktreeManager({ root, autoDeleteLimit: 0, recentMs: 0, prStatus: async () => { if (state === "error") throw new Error("offline"); return { state, checks: [] }; } });
  const wt = await m.create({ repoRoot: repo, sessionId: "session-12345678", prompt: "pr retention" });
  expect((await m.inspectDeletion(wt.path)).prState).toBe("open");
  expect(await m.autoDelete()).toEqual([]); expect(await m.removeForArchivedSession(wt.sessionId)).toBeNull();
  state = "error";
  expect(await m.autoDelete()).toEqual([]); expect(await m.removeForArchivedSession(wt.sessionId)).toBeNull();
  expect(existsSync(wt.path)).toBe(true);
  state = "merged";
  expect(await m.autoDelete()).toEqual([wt.path]); expect(existsSync(wt.path)).toBe(false);
});
