import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { AuthManager, loadToken, setAuthManager } from "../../src/auth/oauth.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { readUserSettings, updateUserSettings } from "../../desktop/main/user-settings.ts";
import { startFakeOAuth } from "../fakes/fake-oauth.ts";
import { tmpEnv } from "../storage/helpers.ts";

const { pw, reason } = chromiumStatus("model setup headless acceptance");
(reason ? test.skip : test)("first-run setup offers registered account sign-in before keys and configures local, cloud and account models", async () => {
  const env = tmpEnv(), oauth = startFakeOAuth(), file = join(env.rigwellHome, "settings.json");
  setCredentialStore(new CredentialStore([new FileBackend()])); setAuthManager(new AuthManager({ intervalUnitMs: 10 }));
  writeFileSync(file, "{}");
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  const replies: string[] = [];
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/model-setup.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path !== "/rpc") return new Response('<div id="root"></div><script>window.fixtureSettings=' + JSON.stringify(readUserSettings(env.rigwellHome)) + '</script><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
      const { method, params } = await req.json() as any;
      if (method === "fixture_read_settings") return Response.json({ result: readUserSettings(env.rigwellHome) });
      if (method === "fixture_update_settings") return Response.json({ result: updateUserSettings(env.rigwellHome, params) });
      let finish!: (response: any) => void;
      const result = new Promise<any>((resolve) => { finish = resolve; });
      const conn = createConnection((line) => { for (const text of line.trim().split("\n")) { const response = JSON.parse(text); if (response.type === "response") { replies.push(text); finish(response); } } }, { canPrompt: false });
      try { conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "setup", method: `rigwell.${method}`, params }) + "\n"); return Response.json(await result); }
      finally { await conn.shutdown(); }
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByText(/Account sign-in is not available: no registered/).waitFor();
    const text = await page.getByRole("region", { name: "Connect a model" }).innerText();
    expect(text.indexOf("Sign in with an account")).toBeLessThan(text.indexOf("API key or local model"));
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Configure a model" }).click();
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("generic-chat-completion-api");
    await page.getByLabel("Model name", { exact: true }).fill("fixture-local");
    await page.getByLabel("Display name", { exact: true }).fill("Local fixture");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit Local fixture", exact: true }).waitFor();
    expect(JSON.parse(readFileSync(file, "utf8")).customModels[0]).toMatchObject({ provider: "generic-chat-completion-api", model: "fixture-local" });
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("bedrock-converse");
    await page.getByLabel("Model name", { exact: true }).fill("fixture-cloud");
    await page.getByLabel("AWS profile", { exact: true }).fill("fixture-profile");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit fixture-cloud", exact: true }).waitFor();
    expect(JSON.parse(readFileSync(file, "utf8")).customModels[1].bedrock).toEqual({ awsRegion: "us-east-1", awsAuthMethod: "profile", awsProfile: "fixture-profile" });

    // Keep the device pending until its code is actually displayed, then play the user's approval.
    oauth.pendingPolls = 10_000;
    writeFileSync(file, JSON.stringify({ oauthProviders: { acme: { clientId: "rigwell-owned-fixture", clientSecret: "fixture-private-client", tokenEndpoint: `${oauth.url}/token`, deviceAuthorizationEndpoint: `${oauth.url}/device`, scopes: ["models.read"] } } }));
    await page.reload();
    await page.getByRole("button", { name: "Sign in to acme with a code" }).click();
    await page.getByText("ABCD-1234", { exact: true }).waitFor();
    oauth.pendingPolls = 0;
    await page.getByTestId("provider-status").filter({ hasText: "Signed in" }).waitFor();
    expect(loadToken("acme")?.accessToken).toBe("access-1");
    expect(await page.getByRole("button", { name: "Sign in to acme with a code" }).innerText()).toBe("Sign in again");
    await page.getByRole("button", { name: "Configure a model" }).click();
    await page.getByRole("button", { name: "Add model", exact: true }).click();
    await page.getByLabel("Provider", { exact: true }).selectOption("google");
    await page.getByLabel("Model name", { exact: true }).fill("fixture-google");
    await page.getByLabel("Model authentication").selectOption("acme");
    expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit fixture-google", exact: true }).waitFor();
    const saved = JSON.parse(readFileSync(file, "utf8")).customModels[0];
    expect(saved).toMatchObject({ provider: "google", credentialSource: "acme" }); expect(saved).not.toHaveProperty("apiKey");
    await page.getByRole("button", { name: "Fixture home" }).click();
    expect(await page.getByRole("region", { name: "Connect a model" }).count()).toBe(0);
    await page.getByRole("button", { name: "Fixture accounts" }).click();
    await page.getByRole("button", { name: "Sign out of acme" }).click();
    await page.getByTestId("provider-status").filter({ hasText: "Signed out" }).waitFor();
    expect(loadToken("acme")).toBeUndefined();
    expect(replies.join("\n")).not.toMatch(/access-1|refresh-1|fixture-private-client/);
    expect(await page.locator("body").innerText()).not.toContain("fixture-private-client");
  } finally { await browser?.close(); web?.stop(true); oauth.stop(); setAuthManager(undefined); setCredentialStore(undefined); env.cleanup(); }
}, 20_000);
