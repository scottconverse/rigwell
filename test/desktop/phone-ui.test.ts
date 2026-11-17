import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";

const { pw, reason } = chromiumStatus("Phone settings headless acceptance");
(reason ? test.skip : test)("phone settings confirms listening, renders an expiring QR and lists/revokes a paired device", async () => {
  const env = tmpEnv(); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  try {
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), automations: false, backgroundServices: false, sidepane: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      if (new URL(req.url).pathname === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      return new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); await page.goto(`http://127.0.0.1:${web.port}/phone`);
    await page.getByLabel("Phone port", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Enable phone access", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Enable encrypted phone access?", exact: true }); await dialog.waitFor();
    expect(daemon.phone.status().listening).toBe(false);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(daemon.phone.status().listening).toBe(false);
    await page.getByRole("button", { name: "Enable phone access", exact: true }).click(); await dialog.getByRole("button", { name: "Enable on this address", exact: true }).click();
    await page.getByRole("button", { name: "Pair a device", exact: true }).click();
    const panel = page.getByRole("region", { name: "One-time phone pairing", exact: true }); await panel.waitFor();
    expect(await panel.getByRole("img", { name: "One-time phone pairing QR code", exact: true }).getAttribute("src")).toStartWith("data:image/png;base64,");
    expect(await panel.innerText()).toContain("Expires:");
    const code = await panel.locator("code").innerText(), status = daemon.phone.status();
    const paired = await fetch(new URL("pair", status.url), { method: "POST", tls: { rejectUnauthorized: false }, headers: { origin: status.url!.slice(0, -1), "content-type": "application/json" }, body: JSON.stringify({ code, name: "Settings fixture phone" }) }); expect(paired.status).toBe(200);
    await page.getByRole("button", { name: "Refresh devices", exact: true }).click(); await page.getByRole("button", { name: "Revoke Settings fixture phone", exact: true }).click();
    await page.getByText("Revoked", { exact: true }).waitFor(); expect(daemon.phone.status().devices[0]!.revokedAt).toBeDefined();
    await page.getByRole("button", { name: "Disable phone access", exact: true }).click(); await page.getByRole("button", { name: "Enable phone access", exact: true }).waitFor(); expect(daemon.phone.status().listening).toBe(false); expect(errors).toEqual([]);
  } catch (e) { console.error("[phone settings]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); env.cleanup(); }
}, 15_000);
