import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
import { createSession } from "../../src/storage/transcript.ts";
import { saveSyncConfig } from "../../src/sync/config.ts";
import { syncNow } from "../../src/sync/service.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
const { pw, reason } = chromiumStatus("Session sync headless acceptance");

(reason ? test.skip : test)("sync page chooses data, shows inactive remote copies and confirms a restore", async () => {
  const env = tmpEnv(), sourceHome = env.rigwellHome, target = join(env.root, "target"), destinationHome = join(env.root, "destination");
  const config = { version: 1, folderIsAuthority: true, target: { kind: "folder", path: target }, kinds: ["session", "settings"], settings: ["diffMode"] };
  const session = createSession({ id: "sync-fixture", cwd: env.root, title: "Imported sync fixture" });
  const connections = new Set<ReturnType<typeof createConnection>>(), closing = new Map<ReturnType<typeof createConnection>, Promise<void>>();
  const shutdown = (c: ReturnType<typeof createConnection>) => { let done = closing.get(c); if (!done) { done = c.shutdown(); closing.set(c, done); } return done; };
  let browser: any, page: any, web: ReturnType<typeof Bun.serve> | undefined;
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "fake-credentials.json"))]));
  try {
    writeJson(join(sourceHome, "settings.json"), { diffMode: "unified" }); saveSyncConfig(config);
    await syncNow({ secrets: [], owner: "source-machine" });
    process.env.RIGWELL_HOME = destinationHome; writeJson(join(destinationHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", apiKey: "fake-key", baseUrl: "http://127.0.0.1:1" }] });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve<{ conn?: ReturnType<typeof createConnection> }, {}>({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/rpc") { if (server.upgrade(req, { data: {} })) return; return new Response("upgrade", { status: 400 }); }
        if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        return new Response(`<div id="root"></div><script>window.fixtureSocket='ws://127.0.0.1:${server.port}/rpc';</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
      }, websocket: {
        open(ws) { const c = createConnection((line) => ws.send(line.trim()), { canPrompt: true }); connections.add(c); ws.data.conn = c; },
        message(ws, text) { ws.data.conn!.peer.feed(text.toString() + "\n"); }, close(ws) { if (ws.data.conn) void shutdown(ws.data.conn); },
      },
    });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); await page.goto(`http://127.0.0.1:${web.port}/sync`);
    await page.getByLabel("Sync destination", { exact: true }).fill(target);
    await page.getByLabel("All machines access this same authoritative filesystem", { exact: true }).check();
    await page.getByRole("button", { name: "Save sync configuration", exact: true }).click();
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    await page.getByRole("button", { name: "View session/sync-fixture", exact: true }).click();
    await page.getByRole("region", { name: "Read-only synced copy", exact: true }).waitFor();
    expect(existsSync(join(destinationHome, "sessions"))).toBe(false);
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).count()).toBe(0);
    await page.getByLabel("Sync working folder", { exact: true }).fill(env.root);
    await page.getByRole("button", { name: "Restore session/sync-fixture", exact: true }).click();
    const prompt = page.getByRole("dialog", { name: "Restore synced copy?", exact: true }); await prompt.waitFor();
    expect(await prompt.innerText()).toContain("Existing files are backed up");
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click(); expect(existsSync(join(destinationHome, "sessions"))).toBe(false);
    await page.getByRole("button", { name: "Restore session/sync-fixture", exact: true }).click();
    await prompt.getByRole("button", { name: "Restore and keep backup", exact: true }).click();
    await page.getByRole("button", { name: "Session menu", exact: true }).waitFor();
    const relative = session.transcriptPath.slice(sourceHome.length); expect(readFileSync(destinationHome + relative, "utf8")).toContain("Imported sync fixture"); expect(errors).toEqual([]);
  } catch (e) { console.error("[sync UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await Promise.all([...connections].map(shutdown)); closeSessionIndexes(); setCredentialStore(undefined); process.env.RIGWELL_HOME = sourceHome; env.cleanup(); }
}, 15_000);
