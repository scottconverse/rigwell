import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { trustFolder } from "../../src/storage/settings.ts";
import { inproc } from "../e2e/inproc.ts";
import { startFakeMcpOAuth } from "../fakes/fake-mcp-oauth.ts";
import { startFakeMcpHttp } from "../fakes/fake-mcp-http.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
const { pw, reason } = chromiumStatus("Connector catalog headless acceptance");
(reason ? test.skip : test)("Catalog fetches only on open, filters, prompts, persists and starts OAuth over the real daemon", async () => {
  const env = tmpEnv(), oauth = startFakeMcpOAuth(), plain = startFakeMcpHttp("json", { requireHeader: ["authorization", "Bearer fixture-token"] }), conn = inproc();
  setCredentialStore(new CredentialStore([new FileBackend()])); setAuthManager(new AuthManager());
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined, hits = 0;
  const sources = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return Response.json({ connectors: [
    { name: "custom", description: "Custom fixture tools", category: "Testing", transport: "http", url: plain.url + "/{{workspace}}", headers: { authorization: "Bearer {{token}}" }, auth: "token", docs: "https://example.com/docs", inputs: [{ name: "workspace", label: "Workspace" }, { name: "token", label: "API token", secret: true }] },
    { name: "protected", description: "Protected fixture tools", category: "Testing", transport: "http", url: oauth.url, auth: "oauth", docs: "https://example.com/docs" },
  ] }); } });
  let settings = { mcpCatalogUrls: [`http://127.0.0.1:${sources.port}/catalog.json`] };
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fixture", apiKey: "fixture", baseUrl: oauth.base }] });
    trustFolder(env.root); const models = await conn.call("list_models", {});
    await conn.call("initialize_session", { cwd: env.root, modelId: models.models[0].id });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/connector-catalog.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/settings") { if (req.method === "POST") settings = { ...settings, ...await req.json() as any }; return Response.json(settings); }
      if (path !== "/rpc") return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
      const { method, params } = await req.json() as any;
      try { return Response.json({ result: await conn.call(method, params) }); } catch (e) { return Response.json({ error: (e as Error).message }); }
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${web.port}`); await page.getByRole("tab", { name: "Installed" }).waitFor(); expect(hits).toBe(0);
    await page.getByRole("tab", { name: "Catalog", exact: true }).click(); await page.getByRole("button", { name: "Add custom", exact: true }).waitFor(); expect(hits).toBe(1);
    await page.getByLabel("Catalog category").selectOption("Testing"); expect(await page.getByRole("button", { name: "Add linear", exact: true }).count()).toBe(0);
    await page.getByLabel("Search catalog").fill("Custom fixture"); expect(await page.getByRole("button", { name: "Add protected", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Add custom", exact: true }).click();
    await page.getByLabel("Workspace", { exact: true }).fill("a/b"); await page.getByLabel("API token", { exact: true }).fill("fixture-token");
    await page.getByRole("button", { name: "Add connector", exact: true }).click();
    await page.getByRole("tab", { name: "Installed" }).click(); await page.getByText("http / connected / 4 tools", { exact: true }).waitFor();
    expect(readFileSync(join(env.rigwellHome, "mcp.json"), "utf8")).not.toContain("fixture-token"); expect(plain.seenHeaders[0]?.authorization).toBe("Bearer fixture-token");
    await page.getByRole("tab", { name: "Catalog", exact: true }).click(); await page.getByRole("button", { name: "Add protected", exact: true }).click();
    const link = page.getByRole("link", { name: "Open the sign-in page" }); await link.waitFor();
    const auth = await fetch((await link.getAttribute("href"))!, { redirect: "manual" }); expect(auth.status).toBe(302); expect((await fetch(auth.headers.get("location")!)).status).toBe(200);
    await page.getByText("protected: Signed in", { exact: true }).waitFor();
    const beforeSave = hits; const saved = settings.mcpCatalogUrls[0] + "?saved";
    await page.getByLabel("Catalog sources", { exact: true }).fill(saved); await page.getByRole("button", { name: "Save catalog sources", exact: true }).click();
    await page.getByText("Saved. Reopen Catalog to load these sources.", { exact: true }).waitFor(); expect(hits).toBe(beforeSave); expect(settings.mcpCatalogUrls).toEqual([saved]);
    await page.getByRole("tab", { name: "Installed" }).click(); await page.getByRole("tab", { name: "Catalog", exact: true }).click();
    await page.getByRole("button", { name: "Add protected", exact: true }).waitFor(); expect(hits).toBe(beforeSave + 1);
    expect(JSON.stringify(conn.out)).not.toContain("fixture-token"); expect(await page.locator("body").innerText()).not.toContain("refresh-");
  } finally { await browser?.close(); web?.stop(true); sources.stop(true); await conn.conn.shutdown(); oauth.stop(); plain.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); }
});
