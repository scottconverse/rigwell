import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { fakeSlack } from "../fakes/fake-slack.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { until } from "../workstreams/helpers.ts";
const { pw, reason } = chromiumStatus("Delegation headless acceptance");
(reason ? test.skip : test)("delegation settings confirm access and show source-tagged live sessions in the production sidebar and transcript", async () => {
  const env = tmpEnv(), slack = fakeSlack(), fake = await startFakeAnthropic([{ text: "Delegated answer visible in both places" }]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "fixture-credentials.json"))]));
  try {
    setSecret("slack-app", "fixture-app-token"); setSecret("slack-bot", "fixture-bot-token");
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fixture-key", baseUrl: fake.url }] });
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, sidepane: false, automations: false, ws: { port: 0 }, delegation: { slackHub: slack.hub } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${web.port}/delegation`); await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByLabel("Project 1 alias", { exact: true }).fill("demo"); await page.getByLabel("Project 1 folder", { exact: true }).fill(env.root);
    await page.getByLabel("Enable Slack delegation", { exact: true }).check(); await page.getByLabel("Slack workspace ID", { exact: true }).fill("T1");
    await page.getByLabel("Slack allowed user IDs", { exact: true }).pressSequentially("U1, U2");
    await page.getByRole("button", { name: "Save delegation settings", exact: true }).click(); await page.getByRole("dialog", { name: "Confirm delegation access", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click(); expect(slack.opens).toBe(0);
    await page.getByRole("button", { name: "Save delegation settings", exact: true }).click(); await page.getByRole("button", { name: "Save access", exact: true }).click();
    await until(() => slack.sockets.size === 1); expect(daemon.delegation!.status().config.slack?.users).toEqual(["U1", "U2"]);
    slack.event("ui-task", "demo: answer the question"); await page.getByRole("navigation", { name: "Sidebar", exact: true }).getByLabel("Session source", { exact: true }).filter({ hasText: "Slack" }).waitFor();
    await page.getByRole("link", { name: "Slack: demo", exact: true }).click(); await page.locator('.session-head [aria-label="Session source"]').filter({ hasText: "Slack" }).waitFor();
    await page.getByText("Delegated answer visible in both places", { exact: true }).waitFor(); expect(errors).toEqual([]);
  } catch (e) { console.error("[delegation UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); slack.stop(); fake.stop(); closeSessionIndexes(); setCredentialStore(undefined); env.cleanup(); }
}, 15_000);
