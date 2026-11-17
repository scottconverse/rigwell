import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { readUserSettings, updateUserSettings } from "../../desktop/main/user-settings.ts";
import { workstreamSettings } from "../../src/workstreams/index.ts";
const { pw, reason } = chromiumStatus("Labs production acceptance"); if (!pw) console.warn(reason);

test.skipIf(!pw)("production Labs toggles and resets effective local flags through the real daemon without launching work", async () => {
  const env = tmpEnv(); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  let rejectSave = false;
  try {
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] }); expect(built.success).toBe(true);
    const js = await built.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/fixture-settings" && req.method === "POST") { if (rejectSave) return new Response("Fixture save refusal", { status: 400 }); try { return Response.json(updateUserSettings(env.rigwellHome, await req.json())); } catch (e) { return new Response((e as Error).message, { status: 400 }); } }
      return new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = [], calls: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^http:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); }); page.on("websocket", (s: any) => s.on("framesent", (f: any) => { try { calls.push(JSON.parse(f.payload).method); } catch {} }));
    await page.goto(`http://127.0.0.1:${web.port}/labs`); const script = page.getByRole("checkbox", { name: "Subagents inside Scripts", exact: true }), nested = page.getByRole("checkbox", { name: "Nested Workstream controls", exact: true }); await script.waitFor(); expect(await script.isChecked()).toBe(false); expect(await nested.isChecked()).toBe(false);
    await script.check(); await page.getByRole("region", { name: "Subagents inside Scripts", exact: true }).getByText(/on; source: features map/).waitFor(); expect(readUserSettings(env.rigwellHome).features.script_subagents).toBe(true);
    await nested.check(); await page.getByRole("region", { name: "Nested Workstream controls", exact: true }).getByText(/on; source: features map/).waitFor(); expect(workstreamSettings(env.root).allowNestedSpawn).toBe(true);
    await nested.uncheck(); await page.getByRole("region", { name: "Nested Workstream controls", exact: true }).getByText(/off; source: features map/).waitFor(); expect(workstreamSettings(env.root).allowNestedSpawn).toBe(false);
    await page.getByRole("button", { name: "Use default for Subagents inside Scripts", exact: true }).click(); await page.getByRole("region", { name: "Subagents inside Scripts", exact: true }).getByText(/off; source: default off/).waitFor(); expect(readUserSettings(env.rigwellHome).features).toEqual({ nested_workstreams: false });
    // A rejected save intentionally restores unchecked; check() asserts the opposite after its click.
    rejectSave = true; await script.click(); await page.getByRole("alert").getByText("Fixture save refusal").waitFor(); expect(await script.isChecked()).toBe(false); expect(readUserSettings(env.rigwellHome).features).toEqual({ nested_workstreams: false });
    expect([...new Set(calls.filter(Boolean))]).toEqual(["rigwell.list_workstreams", "rigwell.get_features"]); expect(calls.filter((method) => method === "rigwell.get_features").length).toBeGreaterThan(3); expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await browser?.close(); await web?.stop(true); await daemon?.stop(); env.cleanup(); }
}, 20_000);
