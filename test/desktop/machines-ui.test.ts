import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
const { pw, reason } = chromiumStatus("Remote machine headless acceptance");
(reason ? test.skip : test)("remote settings add a machine and Home routes a real fake-provider session with its machine chip", async () => {
  const env = tmpEnv(), fake = await startFakeAnthropic([{ text: "Remote agent answered" }]);
  const store = new MachineStore(), remoteHome = join(env.root, "remote-state"), script = join(env.root, "fake-ssh.ts");
  store.save({ name: "remote", host: "owner@fake", platform: process.platform as "win32" | "linux" | "darwin", root: env.root, build: "a".repeat(64), version: "0.1.0" });
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Remote fixture", apiKey: "fake-key", baseUrl: fake.url }] });
  const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  writeFileSync(script, `process.env.RIGWELL_HOME=${JSON.stringify(remoteHome)};process.argv=[process.execPath,${JSON.stringify(cli)},'exec','--input-format','stream-jsonrpc','--output-format','stream-jsonrpc'];await import(${JSON.stringify(cli)});`);
  const connections = new Set<ReturnType<typeof createConnection>>(), closing = new Map<ReturnType<typeof createConnection>, Promise<void>>(), destinations: string[] = [];
  const shutdown = (conn: ReturnType<typeof createConnection>) => { let pending = closing.get(conn); if (!pending) { pending = conn.shutdown(); closing.set(conn, pending); } return pending; };
  let browser: any, page: any, phase = "build", web: ReturnType<typeof Bun.serve> | undefined;
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/machines.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve<{ conn?: ReturnType<typeof createConnection> }, {}>({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/rpc") { if (server.upgrade(req, { data: {} })) return; return new Response("upgrade required", { status: 400 }); }
        if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        return new Response(`<div id="root"></div><script>window.fixtureSocket='ws://127.0.0.1:${server.port}/rpc';</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
      }, websocket: {
        open(ws) { const conn = createConnection((line) => ws.send(line.trim()), { canPrompt: true, connectMachine: async (name) => { destinations.push(name); return new RpcClient(new SshTransport({ name, host: "owner@fake" }, "fixture", { executable: [process.execPath, script] })); } }); connections.add(conn); ws.data.conn = conn; },
        message(ws, text) { ws.data.conn!.peer.feed(text.toString() + "\n"); },
        close(ws) { if (ws.data.conn) void shutdown(ws.data.conn); },
      },
    });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    phase = "settings"; await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByLabel("Machine name").fill("spare"); await page.getByLabel("SSH destination").fill("owner@spare");
    await page.getByRole("button", { name: "Add machine", exact: true }).click(); await page.getByRole("heading", { name: "spare", exact: true }).waitFor();
    expect(store.get("spare").host).toBe("owner@spare");
    phase = "Home";
    // Deliver pending mount autofocus frames while the user is entering the remote folder.
    await page.evaluate(() => {
      const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      let holding = true, seq = 0; const frames = new Map<number, FrameRequestCallback>();
      window.requestAnimationFrame = (fn) => holding ? (frames.set(--seq, fn), seq) : request(fn);
      window.cancelAnimationFrame = (id) => { if (id < 0) frames.delete(id); else cancel(id); };
      (window as any).pendingFocusFrames = () => frames.size;
      (window as any).releaseFocusFrames = () => {
        holding = false; const pending = [...frames.values()]; frames.clear();
        window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
        for (const fn of pending) fn(performance.now());
      };
      document.querySelector<HTMLButtonElement>("nav button")!.click();
    });
    await page.waitForFunction(() => !!document.querySelector('[aria-label="Session machine"]'));
    await page.getByLabel("Session machine").selectOption("remote");
    await page.waitForFunction(() => (window as any).pendingFocusFrames() > 0);
    await page.evaluate(() => document.querySelector('[aria-label="Remote working folder"]')!.addEventListener("focus", () => queueMicrotask(() => (window as any).releaseFocusFrames()), { once: true }));
    await page.getByLabel("Remote working folder").fill(env.root);
    expect(await page.getByLabel("Remote working folder").inputValue()).toBe(env.root);
    phase = "compose"; await page.getByRole("textbox", { name: "Message", exact: true }).fill("Say hello from the remote fixture");
    await page.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]'); return button && !button.disabled; });
    phase = "send";
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
    await page.getByText("Remote agent answered", { exact: true }).waitFor();
    expect(await page.getByLabel("Session machine").textContent()).toBe("remote");
    expect(destinations.length).toBeGreaterThanOrEqual(2); expect(destinations.every((name) => name === "remote")).toBe(true);
    expect(fake.requests.length).toBe(1); expect(errors).toEqual([]);
  } catch (e) { console.error("[machine UI]", phase, page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await Promise.all([...connections].map(shutdown)); fake.stop(); closeSessionIndexes(); env.cleanup(); }
}, 15_000);
