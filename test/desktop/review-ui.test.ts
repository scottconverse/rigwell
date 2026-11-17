import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { CredentialStore, FileBackend, setCredentialStore, storeCredential } from "../../src/storage/credentials.ts";
import { markTrusted } from "../../src/worktree/trust.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { makeGitRepo, sh, tmp } from "../worktree/util.ts";

const { pw, reason } = chromiumStatus("Review headless UI");
(reason ? test.skip : test)("Review renders real branch/PR diffs, semantic moves, Shiki, confirms posts and sends line comments to the real agent", async () => {
  const env = tmpEnv(), repo = makeGitRepo(), bare = tmp("review-ui-bare");
  const before = "export function before() { return 1; }\nconst stable = 2;\n", after = "export function after() { return 1; }\nconst stable = 2;\n";
  writeFileSync(join(repo, "code.ts"), before); sh(repo, "add", "."); sh(repo, "commit", "-qm", "baseline");
  sh(bare, "init", "--bare", "-q", "-b", "main"); sh(repo, "remote", "add", "origin", bare); sh(repo, "checkout", "-qb", "feature/review"); writeFileSync(join(repo, "code.ts"), after);
  const fake = await startFakeAnthropic(Array.from({ length: 10 }, () => ({ text: "Addressed review comments" })));
  writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify({ customModels: [{ provider: "anthropic", model: "fixture", displayName: "Fixture", baseUrl: fake.url, apiKey: "test-key-not-real" }] })); markTrusted(repo);
  setCredentialStore(new CredentialStore([new FileBackend()])); storeCredential("github", "fixture-review-token");
  const base = "a".repeat(40), head = "b".repeat(40), posts: any[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer fixture-review-token") return new Response("refused", { status: 401 });
    const url = new URL(req.url), path = url.pathname;
    if (req.method === "POST") { posts.push(await req.json()); return Response.json({ id: 1 }); }
    if (path.endsWith("/pulls/4")) return Response.json({ title: "Fixture PR", state: "open", base: { sha: base }, head: { sha: head }, changed_files: 1, html_url: "https://github.com/fixture/repo/pull/4" });
    if (path.endsWith("/files")) return Response.json([{ filename: "code.ts", status: "modified", patch: `@@ -1 +1 @@\n-${before.split("\n")[0]}\n+${after.split("\n")[0]}` }]);
    if (path.includes("/contents/")) return Response.json({ encoding: "base64", content: Buffer.from(url.searchParams.get("ref") === base ? before : after).toString("base64"), type: "file" });
    if (path.endsWith("/comments")) return Response.json([{ body: "Existing review comment", path: "code.ts", line: 1, user: { login: "reviewer" } }]);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: [{ name: "test", conclusion: "success" }] });
    return Response.json([]);
  } });
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  const connections = new Set<ReturnType<typeof createConnection>>(), closing = new Map<ReturnType<typeof createConnection>, Promise<void>>();
  const shutdown = (conn: ReturnType<typeof createConnection>) => { let pending = closing.get(conn); if (!pending) { pending = conn.shutdown(); closing.set(conn, pending); } return pending; };
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/review.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), css = readFileSync(join(import.meta.dir, "../../desktop/renderer/styles.css"), "utf8");
    web = Bun.serve<{ conn?: ReturnType<typeof createConnection> }, {}>({ hostname: "127.0.0.1", port: 0, fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/rpc") { if (server.upgrade(req, { data: {} })) return; return new Response("upgrade required", { status: 400 }); }
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(`<link rel="stylesheet" href="/styles.css"><div id="root"></div><script>window.fixtureSocket=${JSON.stringify(`ws://127.0.0.1:${server.port}/rpc`)};window.fixtureCwd=${JSON.stringify(repo)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    }, websocket: {
      open(ws) { const conn = createConnection((text) => ws.send(text), { canPrompt: true, reviewHostDeps: { which: () => null, apiRoot: () => `http://127.0.0.1:${api.port}`, repo: () => ({ provider: "github", host: "github.com", project: "fixture/repo" }) } }); ws.data.conn = conn; connections.add(conn); },
      message(ws, text) { ws.data.conn!.peer.feed(String(text) + "\n"); },
      close(ws) { if (ws.data.conn) void shutdown(ws.data.conn); },
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${web.port}`); await page.getByRole("button", { name: "Load review", exact: true }).click();
    await page.getByRole("tree", { name: "Changed files" }).getByRole("button", { name: "code.ts M", exact: true }).waitFor();
    await page.getByRole("table", { name: "Inline diff" }).getByText(after.split("\n")[0], { exact: true }).waitFor();
    await page.getByLabel("Diff view").selectOption("side");
    await page.getByRole("table", { name: "Side-by-side diff" }).locator('span[style*="--shiki-light"]').first().waitFor();
    await page.getByLabel("Diff view").selectOption("semantic"); await page.getByRole("heading", { name: "moved/renamed function after", exact: true }).waitFor();
    await page.getByLabel("Review source").selectOption("pr"); await page.getByLabel("PR number", { exact: true }).fill("4"); await page.getByRole("button", { name: "Load review", exact: true }).click();
    await page.getByRole("region", { name: "PR review", exact: true }).getByText("test: success", { exact: true }).waitFor();
    expect(await page.getByRole("region", { name: "PR review", exact: true }).innerText()).toContain("Existing review comment");
    await page.getByLabel("Diff view").selectOption("inline"); await page.getByRole("button", { name: "Comment on new line 1", exact: true }).click();
    await page.getByLabel("Comment body", { exact: true }).fill("Please test the changed behavior."); await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByLabel("Show full files", { exact: true }).check(); await page.getByRole("button", { name: "Comment on new line 2", exact: true }).click();
    await page.getByLabel("Comment body", { exact: true }).fill("Please document the stable value."); await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Post comments", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Post review to the PR?", exact: true }); await confirm.waitFor();
    expect(posts).toHaveLength(0); expect(await confirm.innerText()).toContain("Please test the changed behavior.");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click(); await confirm.waitFor({ state: "hidden" }); expect(posts).toHaveLength(0);
    await page.getByRole("button", { name: "Approve", exact: true }).click(); await confirm.waitFor(); await confirm.getByRole("button", { name: "Post approval", exact: true }).click();
    await page.getByText("Review posted: https://github.com/fixture/repo/pull/4", { exact: true }).waitFor();
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ event: "APPROVE", commit_id: head, comments: [{ line: 1, side: "RIGHT" }] });
    expect(posts[0].body).toContain('"code.ts":2 (new):\nPlease document the stable value.');
    await page.getByRole("button", { name: "Load review", exact: true }).click(); await page.getByRole("button", { name: "Comment on new line 1", exact: true }).click();
    await page.getByLabel("Comment body", { exact: true }).fill("Address this logic with a regression test."); await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("button", { name: "Send comments to agent", exact: true }).click(); await page.getByRole("heading", { name: "Agent task", exact: true }).waitFor();
    await page.locator("pre").filter({ hasText: "Addressed review comments" }).waitFor();
    expect(JSON.stringify(fake.requests)).toContain('Address this logic with a regression test.'); expect(JSON.stringify(fake.requests)).toContain("code.ts");
  } finally { await browser?.close(); web?.stop(true); await Promise.all([...connections].map(shutdown)); api.stop(true); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 20_000);
