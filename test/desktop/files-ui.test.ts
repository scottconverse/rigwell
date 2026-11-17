import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmp } from "../worktree/util.ts";
import { listFiles, readWorkspaceFile, writeWorkspaceFile } from "../../src/sidepane/files.ts";
const { pw, reason } = chromiumStatus("file editor headless acceptance");
(reason ? test.skip : test)("production file editor saves the entered text and refuses stale writes", async () => {
  const repo = tmp("files-ui"), file = join(repo, "greet.js"); writeFileSync(file, 'export const greeting = "Helo";\n');
  const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/files.tsx")], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
  expect(build.success).toBe(true); const js = await build.outputs[0]!.text();
  const writes: any[] = [];
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
    if (path === "/rpc") {
      const { method, params } = await req.json();
      try {
        if (method === "daemon.list_files") return Response.json(listFiles(repo, params));
        if (method === "daemon.get_workspace_file_content") return Response.json(readWorkspaceFile(repo, params));
        if (method === "daemon.write_workspace_file_content") { writes.push(params); return Response.json(writeWorkspaceFile(repo, params)); }
        throw new Error("Unexpected method " + method);
      } catch (error: any) { return Response.json({ error: { code: error.code, message: error.message } }); }
    }
    return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.goto(`http://127.0.0.1:${web.port}/`);
    await page.getByRole("button", { name: "greet.js", exact: true }).click();
    for (let i = 0; i < 10; i++) {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const text = `export const greeting = "Hello ${i}";\n`;
      await page.getByLabel("Edit file").fill(text); await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
      expect(writes.at(-1)?.content).toBe(text); expect(readFileSync(file, "utf8")).toBe(text);
    }
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Edit file").fill("stale edit\n"); writeFileSync(file, "another writer\n");
    await page.getByRole("button", { name: "Save", exact: true }).click(); await page.getByRole("alert").getByText("changed on disk", { exact: false }).waitFor();
    expect(readFileSync(file, "utf8")).toBe("another writer\n");
  } finally { await browser.close(); web.stop(true); }
}, 20000);
