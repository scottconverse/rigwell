import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
const { pw, reason } = chromiumStatus("Automation triggers headless acceptance");

(reason ? test.skip : test)("automation create/detail edits GitHub triggers, defaults posting off and chooses named chain sources", async () => {
  const env = tmpEnv(); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json([]); } });
  try {
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, sidepane: false, ws: { port: 0 }, automations: { webhookPort: 0, triggers: { github: { root: `http://127.0.0.1:${api.port}`, token: async () => "fake-token" } } } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${web.port}/automations`); await page.getByRole("button", { name: "New automation", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New automation", exact: true }); await dialog.getByLabel("Name", { exact: true }).fill("Review source"); await dialog.getByLabel("Instructions", { exact: true }).fill("Review new activity");
    await dialog.getByRole("button", { name: "CI", exact: true }).click(); await dialog.getByLabel("GitHub repositories", { exact: true }).fill("o/r"); await dialog.getByRole("button", { name: "Create", exact: true }).click(); await dialog.getByRole("alert").filter({ hasText: "branch" }).waitFor();
    await dialog.getByRole("button", { name: "GitHub", exact: true }).click(); await dialog.getByLabel("GitHub repositories", { exact: true }).fill("o/r");
    await dialog.getByLabel("issue opened", { exact: true }).uncheck(); await dialog.getByLabel("pr updated", { exact: true }).check(); await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("heading", { name: "Review source", exact: true }).waitFor(); const source = daemon.automations!.manager.list()[0]!;
    expect(source.fm.eventTrigger).toEqual({ repos: ["o/r"], events: ["pr_updated"] }); expect(source.fm.postResult).toBe(false);
    await page.getByRole("button", { name: "Edit event trigger", exact: true }).click(); const edit = page.getByRole("dialog", { name: "Edit event trigger", exact: true });
    await edit.getByLabel("Allow posting run results back to the source", { exact: true }).check(); await edit.getByRole("button", { name: "Save event trigger", exact: true }).click();
    await page.getByText("Run results can be posted back to the originating issue, PR or Slack thread.", { exact: true }).waitFor(); expect(daemon.automations!.manager.find(source.id).fm.postResult).toBe(true);
    await page.getByRole("button", { name: "Back to Automations", exact: true }).click(); await page.getByRole("button", { name: "New automation", exact: true }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Follow source"); await dialog.getByLabel("Instructions", { exact: true }).fill("Use its result"); await dialog.getByRole("button", { name: "Chained", exact: true }).click();
    await dialog.getByLabel("Review source", { exact: true }).check(); await dialog.getByLabel("Source outcome", { exact: true }).selectOption("failure"); await dialog.getByRole("button", { name: "Create", exact: true }).click(); await page.getByRole("heading", { name: "Follow source", exact: true }).waitFor();
    expect(daemon.automations!.manager.list().find((a) => a.fm.name === "Follow source")!.fm.eventTrigger).toEqual({ automationIds: [source.id], status: "failure" }); expect(errors).toEqual([]);
  } catch (e) { console.error("[trigger UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); api.stop(true); env.cleanup(); }
}, 15_000);
