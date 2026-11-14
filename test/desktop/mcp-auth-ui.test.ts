import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { trustFolder } from "../../src/storage/settings.ts";
import { inproc } from "../e2e/inproc.ts";
import { startFakeMcpOAuth } from "../fakes/fake-mcp-oauth.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
const { pw, reason } = chromiumStatus("MCP account headless acceptance");
(reason ? test.skip : test)("Connectors signs in, discovers tools, cancels and signs out over the real MCP protocol", async () => {
  const env = tmpEnv(), fake = startFakeMcpOAuth(), conn = inproc();
  setCredentialStore(new CredentialStore([new FileBackend()])); setAuthManager(new AuthManager());
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fixture", apiKey: "fixture", baseUrl: fake.base }] });
    trustFolder(env.root);
    const models = await conn.call("list_models", {});
    await conn.call("initialize_session", { cwd: env.root, modelId: models.models[0].id, mcpServers: [{ name: "protected", type: "http", url: fake.url }] });
    for (let i = 0; i < 100; i++) { if ((await conn.call("list_mcp_servers", {})).servers[0]?.requiresAuth) break; await Bun.sleep(5); }
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/mcp-auth.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path !== "/rpc") return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
      const { method, params } = await req.json() as any;
      try { return Response.json({ result: await conn.call(method, params) }); } catch (e) { return Response.json({ error: (e as Error).message }); }
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByRole("button", { name: "Sign in to protected", exact: true }).click();
    await page.getByRole("button", { name: "Cancel sign-in" }).click();
    await page.getByLabel("MCP sign-in").getByText("protected: cancelled", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign in to protected", exact: true }).click();
    const link = page.getByRole("link", { name: "Open the sign-in page" }); await link.waitFor();
    const authorize = await fetch((await link.getAttribute("href"))!, { redirect: "manual" });
    expect(authorize.status).toBe(302); expect((await fetch(authorize.headers.get("location")!)).status).toBe(200);
    await page.getByText("protected: Signed in", { exact: true }).waitFor();
    await page.getByText("http / connected / 4 tools", { exact: true }).waitFor();
    expect((await conn.call("list_mcp_servers", {})).servers[0]).toMatchObject({ requiresAuth: false, hasAuthTokens: true });
    await page.getByRole("button", { name: "Sign out of protected", exact: true }).click();
    await page.getByRole("button", { name: "Sign in to protected", exact: true }).waitFor();
    expect((await conn.call("list_mcp_servers", {})).servers[0].hasAuthTokens).toBe(false);
    expect(JSON.stringify(conn.out)).not.toContain("access-"); expect(await page.locator("body").innerText()).not.toContain("refresh-");
  } finally { await browser?.close(); web?.stop(true); await conn.conn.shutdown(); fake.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); }
});
