import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { readAnalytics } from "../../src/analytics/analytics.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { inproc } from "../e2e/inproc.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
const { pw, reason } = chromiumStatus("analytics production page acceptance");
if (!pw) console.warn(reason);

test.skipIf(!pw)("production Analytics reads actual fake-provider Session accounting through the daemon, filters groups and exports local CSV", async () => {
  const env = tmpEnv(), cwd = join(env.root, "project"); mkdirSync(cwd);
  let fake: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined, daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any, connection: ReturnType<typeof inproc> | undefined;
  try {
    fake = await startFakeAnthropic([{ toolCalls: [{ name: "Read", input: { path: "missing-private-file" } }] }, { text: "The requested fixture file is missing." }]);
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }] });
    connection = inproc(); const initialized = await connection.call("initialize_session", { cwd }); await connection.turn("Inspect the local missing fixture.");
    const expected = readAnalytics(), requests = fake.requests.length; expect(expected.totals.tools).toBe(1); expect(expected.totals.failures).toBe(1); expect(expected.totals.tokens).toBeGreaterThan(0);
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^https?:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/analytics`); const totals = page.getByRole("region", { name: "Analytics totals" }); await totals.waitFor(); expect(await totals.innerText()).toContain(`${expected.totals.tokens.toLocaleString()} tokens`);
    await page.getByLabel("Group by", { exact: true }).selectOption("model"); const usage = page.getByRole("table", { name: "Usage breakdown" }); await usage.getByRole("rowheader", { name: "custom:Fixture-0", exact: true }).waitFor();
    await page.getByRole("table", { name: "Tool breakdown" }).getByRole("rowheader", { name: "Read", exact: true }).waitFor();
    await page.getByLabel("Filter session", { exact: true }).fill("not-a-session"); await page.getByText("No accounting records match these filters.", { exact: true }).waitFor();
    await page.getByLabel("Filter session", { exact: true }).fill(initialized.sessionId); await totals.waitFor(); expect(await totals.innerText()).toContain(`${expected.totals.tokens.toLocaleString()} tokens`);
    await page.getByRole("button", { name: "Export CSV", exact: true }).click(); await page.getByRole("status").getByText("CSV saved locally.", { exact: true }).waitFor();
    const csv = await page.evaluate(() => (window as any).savedAnalytics); expect(csv).toContain('"usage","model","custom:Fixture-0"'); expect(csv).not.toContain("fake-only"); expect(csv).not.toContain("missing-private-file");
    expect(fake.requests.length).toBe(requests); expect(errors).toEqual([]); expect(external).toEqual([]);
  } catch (e) { console.error("[Analytics UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); await connection?.conn.shutdown(); fake?.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);
