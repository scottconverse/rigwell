import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { inproc } from "../e2e/inproc.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { readUserSettings, updateUserSettings } from "../../desktop/main/user-settings.ts";
import { readSpendStatus } from "../../src/spend/spend.ts";
const { pw, reason } = chromiumStatus("spend production page acceptance"); if (!pw) console.warn(reason);

test.skipIf(!pw)("production Usage spend controls persist validated settings and stop actual daemon engines without running models from the page", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "First answer" }, { text: "Second allowed answer" }]), connection = inproc();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ model: "fixture", displayName: "Fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }] });
    await connection.call("initialize_session", { cwd: env.root }); await connection.turn("First fixture request"); expect(fake.requests).toHaveLength(1);
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] }); expect(built.success).toBe(true);
    const js = await built.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/fixture-settings" && req.method === "POST") { try { return Response.json(updateUserSettings(env.rigwellHome, await req.json())); } catch (e) { return new Response((e as Error).message, { status: 400 }); } }
      return new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};window.fixtureSettings=${JSON.stringify(readUserSettings(env.rigwellHome))};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^http:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/spend`); await page.getByText(/No local caps configured/).waitFor();
    await page.getByLabel("Overall daily USD", { exact: true }).fill("0"); await page.getByLabel("Estimated prices JSON", { exact: true }).fill(JSON.stringify({ "custom:Fixture-0": { inputPerMtok: 1, outputPerMtok: 2, cachedInputPerMtok: .1 } })); await page.getByRole("button", { name: "Save spend limits", exact: true }).click();
    const table = page.getByRole("table", { name: "Effective spend limits" }); await table.getByRole("cell", { name: "blocked", exact: true }).waitFor(); expect(readSpendStatus().config.dailyUsd).toBe(0); expect(fake.requests).toHaveLength(1);
    await connection.turn("Must be refused at the cap"); expect(fake.requests).toHaveLength(1);
    await page.getByLabel("Overall daily USD", { exact: true }).fill(""); await page.getByLabel("Overall monthly USD", { exact: true }).fill("100"); await page.getByRole("button", { name: "Save spend limits", exact: true }).click(); await table.getByRole("cell", { name: "$100", exact: true }).waitFor();
    await connection.turn("Second fixture request"); expect(fake.requests).toHaveLength(2); await page.getByRole("button", { name: "Refresh spending", exact: true }).click();
    await page.getByLabel("Per-model caps JSON", { exact: true }).fill('{"custom:Fixture-0":{"dailyUsd":-1}}'); await page.getByRole("button", { name: "Save spend limits", exact: true }).click(); await page.getByRole("alert").waitFor(); expect(await page.getByRole("alert").innerText()).toContain("nonnegative"); expect(readSpendStatus().config.models).toEqual({});
    expect(fake.requests).toHaveLength(2); expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await browser?.close(); await web?.stop(true); await connection.conn.shutdown(); await daemon?.stop(); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);
