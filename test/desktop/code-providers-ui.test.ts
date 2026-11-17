import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { AuthManager, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, lookupCredential, setCredentialStore } from "../../src/storage/credentials.ts";
import { startFakeOAuth } from "../fakes/fake-oauth.ts";
import { tmpEnv } from "../storage/helpers.ts";

const { pw, reason } = chromiumStatus("Code providers headless UI");
(reason ? test.skip : test)("Settings connects tokens and registered device login through real protocol with account/scopes and no token echo", async () => {
  const env = tmpEnv(), oauth = startFakeOAuth();
  setCredentialStore(new CredentialStore([new FileBackend()])); setAuthManager(new AuthManager({ intervalUnitMs: 10 }));
  writeFileSync(join(env.rigwellHome, "settings.json"), JSON.stringify({ oauthProviders: { gitlab: { clientId: "rigwell-fixture", tokenEndpoint: `${oauth.url}/token`, deviceAuthorizationEndpoint: `${oauth.url}/device`, scopes: ["api"] } } }));
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname, token = req.headers.get("authorization");
    if (token === "Bearer rejected") return new Response("refused", { status: 401 });
    if (path === "/user") return Response.json({ login: "desktop-user" }, token === "Bearer granular" ? {} : { headers: { "x-oauth-scopes": "repo, read:user" } });
    if (path === "/api/v4/user") return Response.json({ username: "desktop-gitlab" });
    if (path === "/oauth/token/info") return Response.json({ scope: ["api", "read_user"] });
    return new Response("not found", { status: 404 });
  } });
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  const responses: string[] = [];
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/code-providers.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path !== "/rpc") return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
      const { method, params } = await req.json() as any;
      let finish!: (response: any) => void;
      const result = new Promise<any>((resolve) => { finish = resolve; });
      const conn = createConnection((line) => { for (const text of line.trim().split("\n")) { const response = JSON.parse(text); if (response.type === "response") { responses.push(text); finish(response); } } }, { canPrompt: false, codeProviderDeps: { apiRoot: () => `http://127.0.0.1:${api.port}` } });
      try { conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "ui", method: `rigwell.${method}`, params }) + "\n"); return Response.json(await result); }
      finally { await conn.shutdown(); }
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${web.port}`);
    const gh = page.getByRole("region", { name: "GitHub", exact: true }), gl = page.getByRole("region", { name: "GitLab", exact: true });
    await gh.getByText("Disconnected", { exact: true }).waitFor();
    expect(await gh.getByRole("button", { name: "Sign in with a code" }).isDisabled()).toBe(true);
    await gh.getByLabel("GitHub token").fill("desktop-private-token"); await gh.getByRole("button", { name: "Connect token" }).click();
    await gh.getByText("Connected as desktop-user (token)", { exact: true }).waitFor();
    expect(await gh.innerText()).toContain("repo, read:user"); expect(await gh.getByLabel("GitHub token").inputValue()).toBe("");
    await gh.getByLabel("GitHub token").fill("rejected"); await gh.getByRole("button", { name: "Replace token" }).click();
    await gh.getByRole("alert").filter({ hasText: "401" }).waitFor(); expect(lookupCredential("github")).toBe("desktop-private-token");
    await gh.getByLabel("GitHub token").fill("granular"); await gh.getByRole("button", { name: "Replace token" }).click();
    await gh.getByText(/Not reported by the provider/).waitFor();
    await gh.getByRole("button", { name: "Disconnect", exact: true }).click(); await gh.getByText("Disconnected", { exact: true }).waitFor();
    expect(lookupCredential("github")).toBeUndefined();
    await gl.getByRole("button", { name: "Sign in with a code" }).click(); await gl.getByText("ABCD-1234", { exact: true }).waitFor();
    await gl.getByText("Connected as desktop-gitlab (OAuth)", { exact: true }).waitFor();
    expect(await gl.innerText()).toContain("api, read_user");
    expect(responses.join("\n")).not.toContain("desktop-private-token"); expect(responses.join("\n")).not.toContain("access-1");
  } finally { await browser?.close(); web?.stop(true); api.stop(true); oauth.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); }
}, 15_000);
