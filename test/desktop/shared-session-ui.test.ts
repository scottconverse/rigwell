import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { parseSharedSession, renderSharedSession, type SharedSession } from "../../src/sharing/format.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
const { pw, reason } = chromiumStatus("Shared session headless acceptance");

(reason ? test.skip : test)("import view is read-only until fork; session menu exports redacted data and confirms uploads", async () => {
  const env = tmpEnv(), source = join(env.root, "shared.html"), secret = "private-fixture-value";
  const value: SharedSession = { schemaVersion: 1, title: "Imported fixture", exportedAt: new Date().toISOString(), messages: [{ role: "user", text: `<script>window.evil=true</script> ${secret}` }, { role: "assistant", text: "Historical response" }] };
  writeFileSync(source, renderSharedSession(value, "html"));
  writeJson(join(env.rigwellHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake-key", baseUrl: "http://127.0.0.1:1" }] });
  const connections = new Set<ReturnType<typeof createConnection>>(), closing = new Map<ReturnType<typeof createConnection>, Promise<void>>();
  const shutdown = (c: ReturnType<typeof createConnection>) => { let done = closing.get(c); if (!done) { done = c.shutdown(); closing.set(c, done); } return done; };
  let uploads = 0, browser: any, page: any, web: ReturnType<typeof Bun.serve> | undefined;
  const gist = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { uploads++; const body = await req.json(); expect(body.public).toBe(false); expect(body.files["rigwell-session.md"].content).not.toContain(secret); return Response.json({ html_url: "https://gist.github.com/fixture/abcde123" }, { status: 201 }); } });
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve<{ conn?: ReturnType<typeof createConnection> }, {}>({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/rpc") { if (server.upgrade(req, { data: {} })) return; return new Response("upgrade", { status: 400 }); }
        if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        return new Response(`<div id="root"></div><script>window.fixtureSocket='ws://127.0.0.1:${server.port}/rpc';window.fixtureFolder=${JSON.stringify(env.root)};window.fixtureSource=${JSON.stringify(source)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
      }, websocket: {
        open(ws) { const c = createConnection((line) => ws.send(line.trim()), { canPrompt: true, shareDeps: { secrets: [secret], token: async () => "fake-token", apiRoot: `http://127.0.0.1:${gist.port}` } }); connections.add(c); ws.data.conn = c; },
        message(ws, text) { ws.data.conn!.peer.feed(text.toString() + "\n"); }, close(ws) { if (ws.data.conn) void shutdown(ws.data.conn); },
      },
    });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message)); await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByRole("button", { name: "Choose shared file", exact: true }).click(); await page.getByRole("button", { name: "Import read-only", exact: true }).click();
    await page.getByRole("heading", { name: "Imported fixture", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).count()).toBe(0); expect(await page.evaluate(() => (window as any).evil)).toBeUndefined();
    await page.getByRole("button", { name: "Choose working folder", exact: true }).click(); await page.getByRole("button", { name: "Fork into new session", exact: true }).click();
    await page.getByRole("button", { name: "Session menu", exact: true }).waitFor();
    await page.getByRole("button", { name: "Session menu", exact: true }).click(); await page.getByRole("menuitem", { name: "Export redacted HTML", exact: true }).click();
    await page.waitForFunction(() => (window as any).savedExport);
    const exported = await page.evaluate(() => (window as any).savedExport); expect(exported.content).not.toContain(secret); expect(parseSharedSession(exported.content).messages).toHaveLength(2);
    await page.getByRole("button", { name: "Session menu", exact: true }).click(); await page.getByRole("menuitem", { name: "Copy share link", exact: true }).click();
    const prompt = page.getByRole("alertdialog", { name: "Share session as an unlisted gist?", exact: true }); await prompt.waitFor();
    expect(await prompt.innerText()).toContain("Anyone with the link can read it"); expect(uploads).toBe(0);
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click(); await prompt.waitFor({ state: "detached" }); expect(uploads).toBe(0);
    await page.getByRole("button", { name: "Session menu", exact: true }).click(); await page.getByRole("menuitem", { name: "Copy share link", exact: true }).click();
    await prompt.getByRole("button", { name: "Create unlisted gist", exact: true }).click();
    await page.waitForFunction(() => (window as any).fixtureClipboard === "https://gist.github.com/fixture/abcde123"); expect(uploads).toBe(1); expect(errors).toEqual([]);
  } catch (e) { console.error("[shared UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); gist.stop(true); await Promise.all([...connections].map(shutdown)); closeSessionIndexes(); env.cleanup(); }
}, 15_000);
