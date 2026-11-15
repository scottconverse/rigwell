import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { wikiFixture } from "../wiki/fixture.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { lastToolResult } from "../e2e/helpers.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { until } from "../workstreams/helpers.ts";
const { pw, reason } = chromiumStatus("wiki production page acceptance");
if (!pw) console.warn(reason);

test.skipIf(!pw)("production Wiki builds/searches/renders diagrams, updates sources, and the real agent reads and installs a local update automation", async () => {
  const env = tmpEnv(), { project } = wikiFixture(env.root), approvals: any[] = [];
  const fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Skill", input: { name: "browse-wiki" } }] },
    (b) => { expect(lastToolResult(b)).toContain("wiki search"); return { toolCalls: [{ name: "Read", input: { path: join(project, ".rigwell/wiki/glossary.md") } }] }; },
    (b) => { expect(lastToolResult(b)).toContain("revised"); return { toolCalls: [{ name: "Skill", input: { name: "install-wiki" } }] }; },
    (b) => { expect(lastToolResult(b)).toContain("every 5m"); return { toolCalls: [{ name: "CreateAutomation", input: { name: "Update project wiki", scope: "project", workingDirectory: project, schedule: "every 5m", autonomy: "high", instructions: "Load the wiki skill, then run rigwell wiki update --after-commit in this project. Report changed pages and warnings; do not push or publish." } }] }; },
    (b) => { expect(lastToolResult(b)).toContain("Update project wiki"); return { text: "Wiki read and update automation saved." }; },
  ]);
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: RpcClient | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake", baseUrl: fake.url }] });
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, sidepane: false, delegation: false, ws: { port: 0 }, automations: { webhookPort: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};window.fixtureFolder=${JSON.stringify(project)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${web.port}/wiki`); await page.getByRole("button", { name: "Choose wiki folder", exact: true }).click(); await page.waitForFunction((expected: string) => document.querySelector<HTMLInputElement>('input[aria-label="Wiki project folder"]')?.value === expected, project);
    await page.getByRole("button", { name: "Build wiki", exact: true }).click(); await page.getByRole("button", { name: "Project overview", exact: true }).waitFor();
    await page.getByRole("button", { name: "Architecture", exact: true }).click(); await page.getByRole("article", { name: "Wiki article" }).locator("svg").waitFor();
    expect(await page.getByRole("article", { name: "Wiki article" }).innerText()).toContain("ui depends on core");
    await page.getByLabel("Search wiki", { exact: true }).fill("clamp"); await page.getByRole("button", { name: "Module: core", exact: true }).waitFor(); await page.getByRole("button", { name: "Module: core", exact: true }).click();
    expect(await page.getByRole("article", { name: "Wiki article" }).innerText()).toContain("core/math.ts:1");
    writeFileSync(join(project, "core/math.ts"), "export function revised() { return 2; }\n"); await page.getByLabel("Search wiki", { exact: true }).fill(""); await page.getByRole("button", { name: "Update wiki", exact: true }).click();
    await page.getByText("4 pages refreshed; 0 removed.", { exact: true }).waitFor(); await page.getByLabel("Search wiki", { exact: true }).fill("revised"); await page.getByRole("button", { name: "Glossary", exact: true }).click(); await page.getByRole("article", { name: "Wiki article" }).getByText("revised", { exact: false }).waitFor();
    expect(readFileSync(join(project, ".rigwell/wiki/glossary.md"), "utf8")).toContain("revised");
    client = new RpcClient(await SocketTransport.connect(daemon.socketPath)); client.onRequest = async (m, p) => { approvals.push({ m, p }); return { selectedOption: "proceed_once" }; };
    const notes: any[] = []; client.onNotification = (_m, p) => { if (p.notification) notes.push(p.notification); };
    await client.request("initialize_session", { cwd: project, autonomyLevel: "high", title: "Wiki fixture" }); await client.request("add_user_message", { text: "Read the wiki and install its local update automation." }); await until(() => notes.some((n) => n.type === "agent_turn_completed"));
    expect(fake.requests).toHaveLength(5); expect(notes.filter((n) => n.type === "error")).toEqual([]); expect(approvals.some((a) => JSON.stringify(a).includes("CreateAutomation"))).toBe(true);
    const automations = await client.request<any>("list_automations", {}); expect(JSON.stringify(automations)).toContain("Update project wiki"); expect(JSON.stringify(automations)).toContain(project.replaceAll("\\", "\\\\"));
    await client.request("close_session", {}); expect(errors).toEqual([]);
  } catch (e) { console.error("[Wiki UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await client?.close(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);

