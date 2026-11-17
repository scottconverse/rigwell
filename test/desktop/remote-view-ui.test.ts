import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { RemoteViews } from "../../desktop/main/remote-view.ts";
import { fakeTunnelSsh } from "../machines/tunnel-fixture.ts";

const { pw, reason } = chromiumStatus("Remote desktop viewer headless acceptance");
(reason ? test.skip : test)("remote desktop viewer renders a fake RFB screen over an owned SSH channel with view-only default", async () => {
  const env = tmpEnv(), sockets = new Set<import("node:net").Socket>();
  let pointerEvents = 0, handshakes = 0;
  const vnc = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buffer = Buffer.alloc(0), phase = 0, redByte = 2;
    socket.write("RFB 003.008\n");
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      while (buffer.length) {
        if (phase === 0) { if (buffer.length < 12) return; buffer = buffer.subarray(12); socket.write(Buffer.from([1, 1])); phase = 1; }
        else if (phase === 1) { buffer = buffer.subarray(1); socket.write(Buffer.alloc(4)); phase = 2; }
        else if (phase === 2) {
          buffer = buffer.subarray(1); const name = Buffer.from("Fixture screen"), init = Buffer.alloc(24);
          init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2); init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8;
          init.writeUInt32BE(name.length, 20); socket.write(Buffer.concat([init, name])); phase = 3; handshakes++;
        } else {
          const type = buffer[0];
          let size = type === 0 ? 20 : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : 0;
          if (type === 2) { if (buffer.length < 4) return; size = 4 + buffer.readUInt16BE(2) * 4; }
          if (type === 6) { if (buffer.length < 8) return; size = 8 + buffer.readUInt32BE(4); }
          if (!size) { socket.destroy(new Error(`Unexpected fake RFB message ${type}`)); return; }
          if (buffer.length < size) return;
          if (type === 0) redByte = buffer[14]! / 8;
          if (type === 5) pointerEvents++;
          if (type === 3) {
            const frame = Buffer.alloc(32); frame.writeUInt16BE(1, 2); frame.writeUInt16BE(2, 8); frame.writeUInt16BE(2, 10);
            for (let i = 16; i < 32; i += 4) frame[i + redByte] = 255;
            socket.write(frame);
          }
          buffer = buffer.subarray(size);
        }
      }
    });
  });
  await new Promise<void>((resolve) => vnc.listen(0, "127.0.0.1", resolve));
  new MachineStore().save({ name: "fixture", host: "owner@fake", build: "a".repeat(64) });
  const views = new RemoteViews(env.rigwellHome, (_owner, event) => peer?.send(JSON.stringify({ event: { ...event, ...(event.data ? { data: [...event.data] } : {}) } })), fakeTunnelSsh(env.root));
  let browser: any, page: any, peer: import("bun").ServerWebSocket<{}> | undefined, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/remote-view.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text();
    web = Bun.serve<{}, {}>({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        if (path === "/rpc") { if (server.upgrade(req, { data: {} })) return; return new Response("upgrade required", { status: 400 }); }
        if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
        return new Response(`<div id="root" style="height:400px;display:flex"></div><script>window.fixtureSocket='ws://127.0.0.1:${server.port}/rpc';</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
      }, websocket: {
        open(ws) { peer = ws; },
        async message(ws, text) {
          const m = JSON.parse(text.toString());
          try {
            let result;
            if (m.method === "open") result = await views.open(1, m.args[0], m.args[1], m.args[2]);
            else if (m.method === "receive") result = views.receive(1, m.args[0]);
            else if (m.method === "send") result = await views.send(1, m.args[0], new Uint8Array(m.args[1]));
            else if (m.method === "close") result = await views.close(1, m.args[0]);
            else throw new Error("Unknown fixture method");
            ws.send(JSON.stringify({ id: m.id, result }));
          } catch (e) { ws.send(JSON.stringify({ id: m.id, error: (e as Error).message })); }
        }, close() { void views.closeOwner(1); },
      },
    });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${web.port}`); await page.getByLabel("Remote port").fill(String((vnc.address() as any).port));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Connected (view only)", { exact: true }).waitFor();
    await page.waitForFunction(() => { const c = document.querySelector("canvas"); return c && c.getContext("2d")!.getImageData(0, 0, 1, 1).data[0] === 255; });
    expect(handshakes).toBe(1);
    await page.locator("canvas").click(); expect(pointerEvents).toBe(0);
    await page.getByLabel("Enable keyboard and pointer input").check(); await page.locator("canvas").click();
    await page.waitForTimeout(50); expect(pointerEvents).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).waitFor(); expect(errors).toEqual([]);
  } catch (e) { console.error("[remote viewer]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await views.closeOwner(1); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => vnc.close(() => resolve())); env.cleanup(); }
}, 15_000);
