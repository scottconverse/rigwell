import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import type { Transport } from "../../src/sdk/transport.ts";
const { pw, reason } = chromiumStatus("Fleet management headless acceptance");

(reason ? test.skip : test)("Machines page shares verified status and guarded actions with the fleet controller", async () => {
  const env = tmpEnv(), store = new MachineStore(), build = "b".repeat(64), events: string[] = [];
  store.save({ name: "remote", host: "owner@fake", platform: "linux", build, version: "0.1.0", root: "/fixture/build" });
  store.save({ name: "offline", host: "owner@unreachable", platform: "win32", lastSeen: "2026-11-13T00:00:00Z" });
  let running = 2;
  const connect = async (name: string) => {
    if (name === "offline") throw new Error("Fixture host unavailable");
    const wire: Transport = { onMessage() {}, onClose() {}, async close() { wire.onClose(); }, write(line) {
      const m = JSON.parse(line), method = m.method.replace(/^rigwell\./, ""); events.push(method);
      queueMicrotask(() => {
        const result = method === "machine_runtime_info" ? { build, pid: 1234, platform: "linux", version: store.get(name).version, runningSessions: running, load: { cpuCount: 4, average: [0.5, 0.2, 0.1], memoryUsed: 4, memoryTotal: 8 } } : method === "machine_stop_sessions" ? { stopped: 2, runningSessions: running = 0 } : { shuttingDown: true };
        wire.onMessage(JSON.stringify({ id: m.id, result })); if (method === "machine_shutdown") wire.onClose();
      });
    } }; return new RpcClient(wire);
  };
  const wire: Transport = { onMessage() {}, onClose() {}, write(line) { connection.peer.feed(line + "\n"); }, async close() { await connection.shutdown(); wire.onClose(); } };
  const connection = createConnection((line) => queueMicrotask(() => wire.onMessage(line.trim())), { canPrompt: false, connectMachine: connect, fleetOptions: { store,
    bootstrap: async (name) => { events.push(`update:${name}`); if (name === "offline") throw new Error("Fixture transfer unavailable"); return store.save({ ...store.get(name), version: "0.2.0" }, true); },
    run: async () => { events.push("restart"); return { code: 0, stdout: JSON.stringify({ build, pid: 5678 }), stderr: "" }; },
  } });
  const client = new RpcClient(wire);
  let browser: any, page: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/fleet.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      if (new URL(req.url).pathname === "/rpc") { const m = await req.json(); try { return Response.json({ result: await client.request(m.method, m.params) }); } catch (e) { return Response.json({ error: (e as Error).message }); } }
      if (new URL(req.url).pathname === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); await page.goto(`http://127.0.0.1:${web.port}`);
    const remote = page.getByRole("article", { name: "Machine remote", exact: true }), offline = page.getByRole("article", { name: "Machine offline", exact: true });
    await remote.getByText("Online", { exact: true }).waitFor(); await offline.getByText("Offline", { exact: true }).waitFor();
    expect(await remote.innerText()).toContain("1-minute load 0.50; 50% memory used; 4 CPUs"); expect(store.get("remote").lastSeen).toBeDefined();
    await remote.getByRole("button", { name: "Stop all sessions" }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Refresh machines' && !b.disabled)); expect(running).toBe(0); expect(events).toContain("machine_stop_sessions");
    await remote.getByRole("button", { name: "Restart daemon" }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await remote.getByRole("button", { name: "Restart daemon" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Update all", exact: true }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture transfer unavailable" }).waitFor(); expect(events).toContain("restart"); expect(store.get("remote").version).toBe("0.2.0");
    await offline.getByRole("button", { name: "Remove machine" }).click(); await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(store.list()).toHaveLength(2);
    await offline.getByRole("button", { name: "Remove machine" }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
    await offline.waitFor({ state: "detached" }); expect(store.list().map((m) => m.name)).toEqual(["remote"]); expect(errors).toEqual([]);
  } catch (e) { console.error("[fleet UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await client.close(); env.cleanup(); }
}, 15_000);
