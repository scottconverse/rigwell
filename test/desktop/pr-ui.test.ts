import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";

const { pw, reason } = chromiumStatus("PR headless UI");
(reason ? test.skip : test)("worktree panel edits PR, confirms before push, handles cancel and displays status", async () => {
  const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/pr.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(build) {
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) }));
  } }] });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } }) });
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByRole("button", { name: "Create PR fixture", exact: true }).click();
    await page.getByLabel("PR title").fill("A title");
    await page.getByLabel("PR body").fill("first line\nsecond line");
    await page.getByLabel("PR base").fill("main");
    await page.getByLabel("Draft PR").check();
    await page.getByRole("button", { name: "Review push and PR" }).click();
    const approval = page.getByRole("alertdialog", { name: "Push branch and create PR?" });
    await approval.waitFor();
    expect(await approval.innerText()).toContain("Branch: feature");
    expect(await approval.innerText()).toContain("Base: main");
    expect(await approval.innerText()).toContain("first line\nsecond line");
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toBe(0);
    await approval.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "nothing was pushed" }).waitFor();
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toBe(0);
    await page.getByRole("button", { name: "Review push and PR" }).click();
    await approval.getByRole("button", { name: "Push branch and create PR", exact: true }).click();
    await page.getByLabel("PR open", { exact: true }).waitFor();
    expect(await page.getByLabel("PR open", { exact: true }).innerText()).toContain("test pending");
    expect(await page.evaluate(() => (window as any).fixture.pushes)).toBe(1);
    expect(await page.getByRole("link", { name: "View PR" }).getAttribute("href")).toBe("https://github.com/owner/repo/pull/7");
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
