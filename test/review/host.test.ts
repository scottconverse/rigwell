import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CredentialStore, FileBackend, setCredentialStore, storeCredential } from "../../src/storage/credentials.ts";
import { ReviewService } from "../../src/review/service.ts";
import { ReviewHost, type ReviewHostDeps } from "../../src/review/host.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { makeGitRepo, sh, tmp } from "../worktree/util.ts";

let env: ReturnType<typeof tmpEnv>, server: ReturnType<typeof Bun.serve>, repo: string;
let posts: { path: string; body: any }[], head: string;
const base = "a".repeat(40), originalHead = "b".repeat(40);
const oldText = "export function before() { return 1; }\n", newText = "export function after() { return 1; }\n";
beforeEach(() => {
  env = tmpEnv(); setCredentialStore(new CredentialStore([new FileBackend()])); storeCredential("github", "fixture-host-token"); storeCredential("gitlab", "fixture-host-token");
  repo = makeGitRepo(); const bare = tmp("review-bare"); sh(bare, "init", "--bare", "-q", "-b", "main"); sh(repo, "remote", "add", "origin", bare);
  posts = []; head = originalHead;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer fixture-host-token");
    const url = new URL(req.url), path = url.pathname;
    if (req.method === "POST") { const body = await req.json(); posts.push({ path, body }); return Response.json(path === "/api/graphql" ? { data: { mergeRequestRequestChanges: { errors: [] } } } : { id: posts.length }); }
    if (/\/(pulls|merge_requests)\/4$/.test(path)) return Response.json({ title: "Fixture review", state: path.includes("pulls") ? "open" : "opened", html_url: "https://github.com/owner/repo/pull/4", web_url: "https://gitlab.com/owner/repo/-/merge_requests/4", base: { sha: base }, head: { sha: head }, diff_refs: { base_sha: base, head_sha: head, start_sha: base }, changed_files: 1, changes_count: "1" });
    if (path.endsWith("/files")) return Response.json([{ filename: "code.ts", status: "modified", patch: "@@ -1 +1 @@\n-" + oldText.trim() + "\n+" + newText.trim() }]);
    if (path.endsWith("/diffs")) return Response.json([{ old_path: "code.ts", new_path: "code.ts", diff: "@@ -1 +1 @@\n-" + oldText.trim() + "\n+" + newText.trim() }]);
    if (path.includes("/contents/") || path.includes("/repository/files/")) return Response.json({ encoding: "base64", content: Buffer.from(url.searchParams.get("ref") === base ? oldText : newText).toString("base64"), type: "file" });
    if (path.endsWith("/comments")) return Response.json([{ path: "code.ts", line: 1, side: "RIGHT", body: "Existing comment", user: { login: "prior-reviewer" } }]);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [{ name: "test", conclusion: "success" }] });
    if (path.endsWith("/statuses")) return Response.json([{ context: "lint", state: "pending" }]);
    if (path.endsWith("/reviews")) return Response.json([{ body: "Existing review summary", user: { login: "review-author" } }]);
    if (path.endsWith("/discussions")) return Response.json([{ notes: [{ body: "GitLab comment", author: { username: "prior-reviewer" }, position: { new_path: "code.ts", new_line: 1 } }] }]);
    if (path.endsWith("/pipelines")) return Response.json([{ id: 12, status: "success" }]);
    return Response.json([]);
  } });
});
afterEach(() => { server.stop(true); setCredentialStore(undefined); env.cleanup(); });
const deps = (provider: "github" | "gitlab" = "github"): ReviewHostDeps => ({ which: () => null, apiRoot: () => `http://127.0.0.1:${server.port}`, repo: () => ({ provider, host: provider === "github" ? "github.com" : "gitlab.com", project: "owner/repo" }) });
const comment = { path: "code.ts", side: "new", line: 1, body: "Please add a regression check." };

test("PR API review loads exact before/after contents, existing comments, checks and semantic renames", async () => {
  const host = await ReviewHost.open(repo, deps()); const snapshot = await host.snapshot(4);
  expect(snapshot.files[0]).toMatchObject({ before: oldText, after: newText });
  expect(snapshot.comments).toContainEqual(expect.objectContaining({ body: "Existing comment", author: "prior-reviewer" }));
  expect(snapshot.comments).toContainEqual(expect.objectContaining({ body: "Existing review summary", author: "review-author" }));
  expect(snapshot.checks).toEqual([{ name: "test", state: "success" }, { name: "lint", state: "pending" }]);
  expect(snapshot.semantic.changes).toMatchObject([{ kind: "moved", renamed: true, name: "after" }]);
  expect(posts).toHaveLength(0);
});

test("PR checks load every page and refuse a provider response that silently truncates checks", async () => {
  const pages: number[] = []; let truncate = false;
  const host = await ReviewHost.open(repo, { ...deps(), fetch: (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("/check-runs")) return fetch(input, init);
    const page = Number(url.searchParams.get("page")); pages.push(page);
    return Response.json({ total_count: 101, check_runs: Array.from({ length: truncate ? 1 : page === 1 ? 100 : 1 }, (_, i) => ({ name: `check-${(page - 1) * 100 + i}`, conclusion: "success" })) });
  }) as typeof fetch });
  const snapshot = await host.snapshot(4);
  expect(pages).toEqual([1, 2]); expect(snapshot.checks).toHaveLength(102);
  truncate = true;
  const error = await host.snapshot(4).then(() => null, (e) => e);
  expect(error.message).toContain("incomplete review checks"); expect(posts).toHaveLength(0);
});

test("every review action confirms complete payload before any write; cancellation and changed head post nothing", async () => {
  let answer = "cancel", mutate = false;
  const service = new ReviewService({ cwd: () => repo, host: deps(), approve: async (params: any) => {
    expect(posts).toHaveLength(0); expect(params.toolUses[0]).toMatchObject({ confirmationType: "code_review", details: { head: originalHead, comments: [comment] } });
    if (mutate) head = "c".repeat(40); return { selectedOption: answer };
  } });
  for (const event of ["COMMENT", "APPROVE", "REQUEST_CHANGES"]) {
    const snapshot: any = await service.handle("review_snapshot", { pr: 4 });
    const error = await service.handle("review_submit", { snapshotId: snapshot.id, event, body: "Summary", comments: [comment] }).then(() => null, (e) => e);
    expect(error.code).toBe(-32800);
  }
  answer = "proceed_once"; mutate = true;
  const snapshot: any = await service.handle("review_snapshot", { pr: 4 });
  const error = await service.handle("review_submit", { snapshotId: snapshot.id, event: "APPROVE", comments: [comment] }).then(() => null, (e) => e);
  expect(error.message).toContain("PR changed"); expect(posts).toHaveLength(0);
});

test("confirmed GitHub review posts inline comments once and rejects a stale duplicate", async () => {
  const service = new ReviewService({ cwd: () => repo, host: deps(), approve: async () => ({ selectedOption: "proceed_once" }) });
  const snapshot: any = await service.handle("review_snapshot", { pr: 4 });
  const task: any = await service.handle("review_task", { snapshotId: snapshot.id, comments: [comment] });
  expect(task.task).toContain(comment.body); expect(posts).toHaveLength(0);
  const input = { snapshotId: snapshot.id, event: "REQUEST_CHANGES", body: "Fix this", comments: [comment] };
  const results = await Promise.allSettled([service.handle("review_submit", input), service.handle("review_submit", input)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect(posts).toHaveLength(1);
  expect(posts[0]?.body).toMatchObject({ commit_id: originalHead, event: "REQUEST_CHANGES", body: "Fix this", comments: [{ path: "code.ts", line: 1, side: "RIGHT", body: comment.body }] });
});

test("GitLab review loads discussion/pipeline data and confirmed actions use discussions, approval SHA and request-changes mutation", async () => {
  const service = new ReviewService({ cwd: () => repo, host: deps("gitlab"), approve: async () => ({ selectedOption: "proceed_once" }) });
  let snapshot: any = await service.handle("review_snapshot", { pr: 4 });
  expect(snapshot.comments[0].body).toBe("GitLab comment"); expect(snapshot.checks).toEqual([{ name: "Pipeline 12", state: "success" }]);
  await service.handle("review_submit", { snapshotId: snapshot.id, event: "APPROVE", body: "Looks good", comments: [comment] });
  expect(posts[0]?.body.position).toMatchObject({ head_sha: originalHead, base_sha: base, new_line: 1 });
  expect(posts.at(-1)).toMatchObject({ path: "/projects/owner%2Frepo/merge_requests/4/approve", body: { sha: originalHead } });
  snapshot = await service.handle("review_snapshot", { pr: 4 });
  await service.handle("review_submit", { snapshotId: snapshot.id, event: "REQUEST_CHANGES", body: "Please revise" });
  expect(posts.at(-1)).toMatchObject({ path: "/api/graphql", body: { variables: { project: "owner/repo", iid: "4" } } });
});

test("the real provider CLI runner passes JSON through stdin and keeps credentials out of argv", async () => {
  writeFileSync(join(repo, "api"), 'const body=await Bun.stdin.json(); if(process.env.GH_TOKEN!=="fixture-host-token"||process.argv.includes("fixture-host-token"))process.exit(2); console.log(JSON.stringify({event:body.event}));');
  const host = await ReviewHost.open(repo, { ...deps(), which: () => process.execPath });
  expect(await host.request("/repos/owner/repo/pulls/4/reviews", { event: "COMMENT", body: "A multiline\nreview" })).toEqual({ event: "COMMENT" });
  expect(posts).toHaveLength(0);
});

test("normal protocol exposes branch snapshots and prepared tasks; a headless connection cannot post", async () => {
  const out: any[] = [], conn = createConnection((text) => { for (const line of text.trim().split("\n")) out.push(JSON.parse(line)); }, { canPrompt: false, reviewHostDeps: deps() });
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = crypto.randomUUID(); conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
    const deadline = Date.now() + 3000; while (!out.some((r) => r.id === id)) { if (Date.now() > deadline) throw new Error("Protocol did not respond"); await Bun.sleep(2); }
    return out.find((r) => r.id === id);
  };
  try {
    const snapshot = (await call("review_snapshot", { cwd: repo, pr: 4 })).result;
    expect((await call("review_task", { snapshotId: snapshot.id, comments: [comment] })).result.task).toContain(comment.body);
    expect((await call("review_submit", { snapshotId: snapshot.id, event: "APPROVE" })).error.code).toBe(-32800);
    expect(posts).toHaveLength(0);
  } finally { await conn.shutdown(); }
});
