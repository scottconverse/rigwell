import { expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { tmpEnv } from "../storage/helpers.ts";
import { openBrowserTunnel, remotePort } from "../../src/machines/tunnel.ts";
import { RemoteViews } from "../../desktop/main/remote-view.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { fakeTunnelSsh } from "./tunnel-fixture.ts";

test("browser tunnel forwards HTTP only to remote loopback and closes owned active channels", async () => {
  const env = tmpEnv(), target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`Remote ${new URL(req.url).pathname}`) });
  const tunnel = await openBrowserTunnel({ name: "fixture", host: "owner@fake" }, target.port!, fakeTunnelSsh(env.root));
  try {
    expect(new URL(tunnel.url).hostname).toBe("127.0.0.1");
    expect(await (await fetch(tunnel.url + "fixture")).text()).toBe("Remote /fixture");
    const socket = connect(Number(new URL(tunnel.url).port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve())); socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await tunnel.close(); await closed;
    let rejected = false; try { await fetch(tunnel.url); } catch { rejected = true; } expect(rejected).toBe(true);
    for (const port of [0, -1, 65536, "5900", 1.5, NaN]) expect(() => remotePort(port)).toThrow();
  } finally { await tunnel.close(); target.stop(true); env.cleanup(); }
}, 5000);

test("desktop stream ownership and receive credits bound delivery and close on owner loss", async () => {
  const env = tmpEnv(), executable = fakeTunnelSsh(env.root);
  new MachineStore().save({ name: "fixture", host: "owner@fake", build: "a".repeat(64) });
  const sockets = new Set<ReturnType<typeof connect>>();
  const server = createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); s.write("fixture banner"); s.on("data", (d) => s.write(d)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const events: any[] = [], waiters: (() => void)[] = [];
  const views = new RemoteViews(env.rigwellHome, (_owner, event) => { events.push(event); for (const wake of waiters.splice(0)) wake(); }, executable);
  try {
    const { id } = await views.open(1, "fixture", (server.address() as any).port, "desktop");
    expect(() => views.receive(2, id)).toThrow("Unknown viewer");
    expect(events.length).toBe(0);
    const event = async () => { if (!events.length) await new Promise<void>((resolve) => waiters.push(resolve)); return events.shift(); };
    views.receive(1, id);
    expect(Buffer.from((await event()).data).toString()).toBe("fixture banner");
    await views.send(1, id, new TextEncoder().encode("echo"));
    expect(events.length).toBe(0); views.receive(1, id);
    expect(Buffer.from((await event()).data).toString()).toBe("echo");
    await views.closeOwner(2); expect(() => views.receive(2, id)).toThrow();
    await views.closeOwner(1); expect(() => views.receive(1, id)).toThrow();
  } finally { await views.closeOwner(1); for (const s of sockets) s.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); env.cleanup(); }
}, 5000);
