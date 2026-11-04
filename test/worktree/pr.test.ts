// create_pr and PR status (spec 18.6) against a local bare origin, a fake gh and a fake GitHub API. Never real GitHub.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPr, hasOpenPr, planPr, prStatus, repoSlug, summarizeChecks, type PrDeps } from "../../src/worktree/pr.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import { makeGitRepo, sh, tmp } from "./util.ts";

const FAKE_GH = join(import.meta.dir, "../fakes/fake-gh.ts");
const ghCmd = ["bun", FAKE_GH];

let ghDir: string;
beforeEach(() => {
  process.env.RIGWELL_HOME = tmp("home");
  ghDir = tmp("gh");
  process.env.FAKE_GH_DIR = ghDir;
});
const ghCalls = (): string[][] => (existsSync(join(ghDir, "calls.jsonl")) ? readFileSync(join(ghDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).args) : []);
const ghAnswers = (cfg: Record<string, unknown>) => writeFileSync(join(ghDir, "fake-gh.json"), JSON.stringify(cfg));

/** A repo whose origin is a bare repo at <tmp>/acme/widget.git, on a feature branch with two commits. */
function featureRepo() {
  const repo = makeGitRepo();
  const bare = join(tmp("bare"), "acme", "widget.git");
  sh(repo, "init", "-q", "--bare", "-b", "main", bare);
  sh(repo, "remote", "add", "origin", bare);
  sh(repo, "push", "-q", "-u", "origin", "main");
  sh(repo, "remote", "set-head", "origin", "main");
  sh(repo, "checkout", "-q", "-b", "rigwell/fix-greeting");
  writeFileSync(join(repo, "a.txt"), "two\n");
  sh(repo, "commit", "-qam", "Fix the greeting");
  writeFileSync(join(repo, "a.txt"), "three\n");
  sh(repo, "commit", "-qam", "Add a test");
  return { repo, bare };
}
const remoteHas = (bare: string, branch: string) => sh(bare, "branch", "--list", branch).includes(branch);

const yes = async () => ({ selectedOption: "proceed_once" });
const no = async () => ({ selectedOption: "cancel" });

const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

/** A fake GitHub REST API. `routes` maps "METHOD /path" (no query) to a JSON answer or a function of the request. */
function fakeApi(routes: Record<string, unknown | ((req: Request, body: any) => unknown)>) {
  const seen: { method: string; path: string; query: string; auth: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : undefined;
      seen.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.get("authorization"), body });
      const r = routes[`${req.method} ${u.pathname}`];
      if (r === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(typeof r === "function" ? (r as any)(req, body) : r, { status: req.method === "POST" ? 201 : 200 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

describe("helpers", () => {
  test("repoSlug reads owner/repo from https, ssh, scp-like and local path remotes", () => {
    expect(repoSlug("https://github.com/acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
    expect(repoSlug("git@github.com:acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
    expect(repoSlug("ssh://git@github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
    expect(repoSlug("C:\\tmp\\x\\acme\\widget.git")).toEqual({ owner: "acme", repo: "widget" });
    expect(repoSlug("widget")).toBeNull();
  });

  test("summarizeChecks counts check runs and commit statuses", () => {
    expect(summarizeChecks([])).toMatchObject({ total: 0, state: "none" });
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "success" }])).toMatchObject({ total: 2, passed: 2, state: "passing" });
    expect(summarizeChecks([{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }])).toMatchObject({ passed: 1, pending: 1, state: "pending" });
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { state: "pending" }])).toMatchObject({ failed: 1, pending: 1, state: "failing" });
  });

  test("planPr: base from origin HEAD, title from the last commit, body from the commits", async () => {
    const { repo } = featureRepo();
    const plan = await planPr(repo, {});
    expect(plan).toEqual({ branch: "rigwell/fix-greeting", base: "main", remote: "origin", title: "Add a test", body: "- Fix the greeting\n- Add a test", draft: false });
    expect((await planPr(repo, { title: "T", body: "B", base: "dev", draft: true }))).toMatchObject({ title: "T", body: "B", base: "dev", draft: true });
  });
});

describe("create_pr", () => {
  test("without an approver it refuses and nothing is pushed", async () => {
    const { repo, bare } = featureRepo();
    await expect(createPr(repo, {}, undefined, { deps: { gh: ghCmd } })).rejects.toThrow(/nothing was pushed/);
    expect(remoteHas(bare, "rigwell/fix-greeting")).toBe(false);
    expect(ghCalls()).toEqual([]);
  });

  test("the confirmation shows branch, base, title and body; cancel pushes nothing", async () => {
    const { repo, bare } = featureRepo();
    let asked: any;
    const r = await createPr(repo, { title: "Fix it" }, async (p) => { asked = p; return await no(); }, { deps: { gh: ghCmd } });
    expect(r).toEqual({ created: false, cancelled: true });
    const tu = asked.toolUses[0];
    expect(tu.confirmationType).toBe("create_pr");
    expect(tu.details).toMatchObject({ branch: "rigwell/fix-greeting", base: "main", title: "Fix it", body: "- Fix the greeting\n- Add a test" });
    expect(asked.options.map((o: any) => o.value)).toEqual(["proceed_once", "cancel"]);
    expect(remoteHas(bare, "rigwell/fix-greeting")).toBe(false);
    expect(ghCalls()).toEqual([]);
  });

  test("with gh: approve pushes the branch and runs gh pr create; returns url and number", async () => {
    const { repo, bare } = featureRepo();
    ghAnswers({ createUrl: "https://github.com/acme/widget/pull/42" });
    const r = await createPr(repo, { title: "Fix it", body: "Why: typo", draft: true }, yes, { deps: { gh: ghCmd } });
    expect(r).toEqual({ created: true, url: "https://github.com/acme/widget/pull/42", number: 42, branch: "rigwell/fix-greeting", base: "main", via: "gh" });
    expect(remoteHas(bare, "rigwell/fix-greeting")).toBe(true);
    expect(sh(repo, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/rigwell/fix-greeting");
    expect(ghCalls()).toEqual([["pr", "create", "--head", "rigwell/fix-greeting", "--base", "main", "--title", "Fix it", "--body", "Why: typo", "--draft"]]);
  });

  test("with gh: a gh failure is reported", async () => {
    const { repo } = featureRepo();
    ghAnswers({ createError: "a pull request for branch already exists" });
    await expect(createPr(repo, {}, yes, { deps: { gh: ghCmd } })).rejects.toThrow(/gh pr create failed: a pull request for branch already exists/);
  });

  test("without gh: the REST API with the stored token", async () => {
    const { repo, bare } = featureRepo();
    const api = fakeApi({ "POST /repos/acme/widget/pulls": (_r: Request, b: any) => ({ number: 9, html_url: `https://github.com/acme/widget/pull/9`, echo: b }) });
    const deps: PrDeps = { gh: null, token: () => "test-token-not-real", apiBase: api.url };
    const r = await createPr(repo, { base: "main" }, yes, { deps });
    expect(r).toMatchObject({ created: true, number: 9, url: "https://github.com/acme/widget/pull/9", via: "api" });
    expect(remoteHas(bare, "rigwell/fix-greeting")).toBe(true);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]!.auth).toBe("Bearer test-token-not-real");
    expect(api.seen[0]!.body).toEqual({ title: "Add a test", body: "- Fix the greeting\n- Add a test", head: "rigwell/fix-greeting", base: "main", draft: false });
  });

  test("without gh and without a token: refused before asking; nothing pushed", async () => {
    const { repo, bare } = featureRepo();
    let asked = false;
    await expect(createPr(repo, {}, async () => { asked = true; return await yes(); }, { deps: { gh: null, token: () => undefined } })).rejects.toThrow(/install the gh CLI or store a token as "github"/);
    expect(asked).toBe(false);
    expect(remoteHas(bare, "rigwell/fix-greeting")).toBe(false);
  });

  test("the token comes from the credential store under the name github", async () => {
    const { repo } = featureRepo();
    const prev = process.env.RIGWELL_CREDENTIALS;
    process.env.RIGWELL_CREDENTIALS = "file";
    const { setCredentialStore, storeCredential } = await import("../../src/storage/credentials.ts");
    setCredentialStore(undefined);
    try {
      storeCredential("github", "stored-token-not-real");
      const api = fakeApi({ "POST /repos/acme/widget/pulls": { number: 3, html_url: "https://github.com/acme/widget/pull/3" } });
      const r = await createPr(repo, {}, yes, { deps: { gh: null, apiBase: api.url } });
      expect(r).toMatchObject({ created: true, number: 3 });
      expect(api.seen[0]!.auth).toBe("Bearer stored-token-not-real");
    } finally {
      setCredentialStore(undefined);
      if (prev === undefined) delete process.env.RIGWELL_CREDENTIALS; else process.env.RIGWELL_CREDENTIALS = prev;
    }
  });

  test("a detached HEAD is refused", async () => {
    const { repo } = featureRepo();
    sh(repo, "checkout", "-q", "--detach");
    await expect(createPr(repo, {}, yes, { deps: { gh: ghCmd } })).rejects.toThrow(/Detached HEAD/);
  });
});

describe("get_pr_status", () => {
  test("with gh: open with a checks summary; none when gh finds no PR", async () => {
    const { repo } = featureRepo();
    expect(await prStatus(repo, { gh: ghCmd })).toEqual({ state: "none", branch: "rigwell/fix-greeting" });
    ghAnswers({ view: { number: 42, url: "https://github.com/acme/widget/pull/42", state: "OPEN", isDraft: false, statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }, { __typename: "StatusContext", state: "SUCCESS" },
    ] } });
    expect(await prStatus(repo, { gh: ghCmd })).toEqual({
      state: "open", branch: "rigwell/fix-greeting", number: 42, url: "https://github.com/acme/widget/pull/42", draft: false,
      checks: { total: 3, passed: 2, failed: 0, pending: 1, state: "pending" },
    });
    expect(ghCalls().at(-1)).toEqual(["pr", "view", "rigwell/fix-greeting", "--json", "number,url,state,isDraft,statusCheckRollup"]);
    ghAnswers({ view: { number: 42, url: "u", state: "MERGED", isDraft: false, statusCheckRollup: [] } });
    expect(await prStatus(repo, { gh: ghCmd })).toMatchObject({ state: "merged", checks: { state: "none" } });
  });

  test("without gh: pulls, check runs and statuses from the API", async () => {
    const { repo } = featureRepo();
    const api = fakeApi({
      "GET /repos/acme/widget/pulls": [{ number: 9, html_url: "https://github.com/acme/widget/pull/9", state: "closed", merged_at: null, draft: false, head: { sha: "abc" } }],
      "GET /repos/acme/widget/commits/abc/check-runs": { check_runs: [{ status: "completed", conclusion: "failure" }] },
      "GET /repos/acme/widget/commits/abc/status": { statuses: [{ state: "success" }] },
    });
    const s = await prStatus(repo, { gh: null, token: () => "t", apiBase: api.url });
    expect(s).toMatchObject({ state: "closed", number: 9, checks: { total: 2, passed: 1, failed: 1, state: "failing" } });
    expect(api.seen[0]!.query).toContain(`head=${encodeURIComponent("acme:rigwell/fix-greeting")}`);
    expect(api.seen[0]!.query).toContain("state=all");
  });
});

describe("auto-delete and open pull requests (spec 18.5)", () => {
  test("hasOpenPr: no upstream and no recorded PR is not looked up; an open PR is; unreachable GitHub falls back to the record", async () => {
    const { repo } = featureRepo();
    expect(await hasOpenPr({ path: repo }, { gh: ghCmd })).toBe(false);
    expect(ghCalls()).toEqual([]);
    sh(repo, "push", "-q", "-u", "origin", "rigwell/fix-greeting");
    expect(await hasOpenPr({ path: repo }, { gh: ghCmd })).toBe(false); // gh: no pull requests found
    ghAnswers({ view: { number: 1, url: "u", state: "OPEN", isDraft: false, statusCheckRollup: [] } });
    expect(await hasOpenPr({ path: repo }, { gh: ghCmd })).toBe(true);
    const off: PrDeps = { gh: null, token: () => undefined };
    expect(await hasOpenPr({ path: repo }, off)).toBe(false);
    expect(await hasOpenPr({ path: repo, pr: { number: 1, url: "u" } }, off)).toBe(true);
    ghAnswers({ view: "not json" as any });
    expect(await hasOpenPr({ path: repo }, { gh: ghCmd })).toBe(true); // an unknown answer keeps the worktree
  });

  test("the manager's auto-delete pass skips a worktree whose branch has an open PR", async () => {
    const repo = makeGitRepo();
    let t = 1_000_000;
    const asked: string[] = [];
    const m = new WorktreeManager({ root: tmp("root"), autoDeleteLimit: 0, recentMs: 0, now: () => (t += 1000), hasOpenPr: async (w) => { asked.push(w.sessionId); return w.sessionId === "pr000001"; } });
    const a = await m.create({ repoRoot: repo, sessionId: "pr000001" }); // each create runs a pass; limit 0
    const b = await m.create({ repoRoot: repo, sessionId: "pr000002" });
    expect(b.autoDeleted).toEqual([]); // a is kept: open PR
    expect(await m.autoDelete()).toEqual([b.path]);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(false);
    expect(asked).toContain("pr000001");
  });
});
