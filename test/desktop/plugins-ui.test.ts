import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { pluginFixture } from "../plugins/fixture.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { lastToolResult } from "../e2e/helpers.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { until } from "../workstreams/helpers.ts";
const { pw, reason } = chromiumStatus("plugin production page acceptance");

(reason ? test.skip : test)("production Plugins page previews/cancels trust, installs into real new sessions, updates, disables and uninstalls", async () => {
  const env = tmpEnv(), source = pluginFixture(join(env.root, "source")), project = join(env.root, "project"); mkdirSync(project);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"); const sha = git("rev-parse", "HEAD"), bare = join(env.root, "origin.git"); git("clone", "--bare", source, bare);
  const index = join(env.root, "marketplace"); writeJson(join(index, "rigwell-marketplace.json"), { plugins: [{ name: "fixture-plugin", source: bare, commit: sha, description: "Pinned fixture entry" }] });
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Skill", input: { name: "fixture-skill" } }] },
    (body) => { expect(lastToolResult(body)).toContain("Follow the fixture instructions"); return { text: "Plugin instructions received" }; },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: RpcClient | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake", baseUrl: fake.url }] });
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${web.port}/plugins`); await page.getByText("No marketplace indexes configured.", { exact: true }).waitFor();
    await page.getByLabel("Plugin source", { exact: true }).fill(source); await page.getByRole("button", { name: "Preview installation", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Trust plugin fixture-plugin?", exact: true }); await dialog.waitFor();
    expect(await dialog.innerText()).toContain("SessionStart"); expect(await dialog.innerText()).toContain("MCP servers"); expect(await dialog.getByRole("listitem").count()).toBe(6);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(daemon.plugins.methods.list_plugins().plugins).toHaveLength(0); expect(existsSync(join(project, "plugin-hook.txt"))).toBe(false);
    await page.getByRole("button", { name: "Preview installation", exact: true }).click(); await dialog.getByRole("button", { name: "Trust and install", exact: true }).click();
    await page.getByRole("button", { name: "Disable fixture-plugin", exact: true }).waitFor();
    client = new RpcClient(await SocketTransport.connect(daemon.socketPath)); client.onRequest = async () => ({ selectedOption: "proceed_once" });
    const notes: any[] = []; client.onNotification = (_m, p) => { if (p.notification) notes.push(p.notification); };
    await client.request("initialize_session", { cwd: project, autonomyLevel: "high", title: "Plugin fixture" });
    await client.request("add_user_message", { text: "Load the fixture plugin skill" }); await until(() => notes.some((n) => n.type === "agent_turn_completed")); expect(fake.requests).toHaveLength(2);
    expect(readFileSync(join(project, "plugin-hook.txt"), "utf8")).toBe("approved-hook"); // the first turn awaits startup hooks; initialization itself does not
    await client.request("close_session", {});
    await page.getByRole("button", { name: "Disable fixture-plugin", exact: true }).click(); await page.getByRole("button", { name: "Enable fixture-plugin", exact: true }).waitFor();
    await page.reload(); await page.getByRole("button", { name: "Enable fixture-plugin", exact: true }).click(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(daemon.plugins.methods.list_plugins().plugins[0]!.enabled).toBe(false);
    await page.getByRole("button", { name: "Enable fixture-plugin", exact: true }).click(); await dialog.getByRole("button", { name: "Trust and install", exact: true }).click(); await page.getByRole("button", { name: "Disable fixture-plugin", exact: true }).waitFor();
    pluginFixture(source, "2.0.0"); await page.getByRole("button", { name: "Update fixture-plugin", exact: true }).click(); await page.getByRole("button", { name: "Preview update", exact: true }).click(); await dialog.getByRole("button", { name: "Trust and install", exact: true }).click(); await page.getByRole("heading", { name: "fixture-plugin 2.0.0", exact: true }).waitFor();
    await page.getByRole("button", { name: "Uninstall fixture-plugin", exact: true }).click(); await page.getByRole("dialog", { name: "Uninstall fixture-plugin?", exact: true }).getByRole("button", { name: "Uninstall plugin", exact: true }).click(); await page.getByText("No plugins installed.", { exact: true }).waitFor();
    expect(daemon.plugins.methods.list_plugins().plugins).toHaveLength(0); expect(errors).toEqual([]);
    await page.getByLabel("Plugin source", { exact: true }).fill(index); await page.getByLabel("Marketplace name", { exact: true }).fill("fixture-index"); await page.getByRole("button", { name: "Add or refresh index", exact: true }).click();
    const market = page.getByRole("region", { name: "Marketplace fixture-index", exact: true }); await market.waitFor(); expect(await market.innerText()).toContain(sha);
    await market.getByRole("button", { name: "Preview fixture-plugin", exact: true }).click(); await dialog.waitFor(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(daemon.plugins.methods.list_plugins().plugins).toHaveLength(0);
    await market.getByRole("button", { name: "Remove index fixture-index", exact: true }).click(); await page.getByText("No marketplace indexes configured.", { exact: true }).waitFor(); expect(errors).toEqual([]);
  } catch (e) { console.error("[Plugins UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await client?.close(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);
