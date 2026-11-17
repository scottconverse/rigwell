import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { inproc } from "../e2e/inproc.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { readUserSettings, updateUserSettings } from "../../desktop/main/user-settings.ts";
const { pw, reason } = chromiumStatus("fallback settings production acceptance"); if (!pw) console.warn(reason);

test.skipIf(!pw)("production fallback controls save order, reject auto and drive the next actual engine without page model calls", async () => {
  const env = tmpEnv(), primary = await startFakeAnthropic([{ status: 401 }]), backup = await startFakeAnthropic([{ text: "Configured fallback answered" }]), c = inproc();
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    writeJson(join(env.rigwellHome, "settings.json"), { autoSessionTitle: false, customModels: [primary, backup].map((server, i) => ({ model: "fixture", displayName: i ? "Backup" : "Primary", provider: "anthropic", baseUrl: server.url, apiKey: "fake-only" })) });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] }); expect(built.success).toBe(true);
    const js = await built.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/fixture-settings" && req.method === "POST") { try { return Response.json(updateUserSettings(env.rigwellHome, await req.json())); } catch (e) { return new Response((e as Error).message, { status: 400 }); } }
      return new Response(`<div id="root"></div><script>window.fixtureSettings=${JSON.stringify(readUserSettings(env.rigwellHome))};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^http:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/fallback`); const input = page.getByLabel("Ordered fallback profile IDs", { exact: true }); await input.fill("custom:Backup-1\ncustom:Backup-1"); await page.getByRole("button", { name: "Save fallback models", exact: true }).click(); await page.getByRole("status").waitFor();
    expect(readUserSettings(env.rigwellHome).fallbackModels).toEqual(["custom:Backup-1"]); expect(primary.requests).toHaveLength(0); expect(backup.requests).toHaveLength(0);
    await input.fill("auto"); await page.getByRole("button", { name: "Save fallback models", exact: true }).click(); await page.getByRole("alert").waitFor(); expect(readUserSettings(env.rigwellHome).fallbackModels).toEqual(["custom:Backup-1"]);
    await c.call("initialize_session", { cwd: env.root, modelId: "custom:Primary-0" }); await c.turn("Use the saved pool"); expect(primary.requests).toHaveLength(1); expect(backup.requests).toHaveLength(1); expect(c.conn.session!.lastTurn?.text).toBe("Configured fallback answered");
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await browser?.close(); await web?.stop(true); await c.conn.shutdown(); primary.stop(); backup.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);
