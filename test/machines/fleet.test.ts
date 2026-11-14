import { expect, test } from "bun:test";
import { MachineFleet } from "../../src/machines/fleet.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import type { Transport } from "../../src/sdk/transport.ts";
import { tmpEnv } from "../storage/helpers.ts";

const build = "a".repeat(64);
const info = { build, pid: 1234, platform: "linux", version: "0.1.0", runningSessions: 0, load: { cpuCount: 4, average: [0.3, 0.2, 0.1], memoryUsed: 2, memoryTotal: 8 } };
function channel(handle: (method: string, p: any) => unknown) {
  let closed = false;
  const wire: Transport = { onMessage() {}, onClose() {},
    write(line) {
      const m = JSON.parse(line), method = m.method.replace(/^rigwell\./, "");
      queueMicrotask(async () => {
        try {
          const result = await handle(method, m.params);
          wire.onMessage(JSON.stringify({ id: m.id, result }));
          if (method === "machine_shutdown") await wire.close();
        } catch (e) { wire.onMessage(JSON.stringify({ id: m.id, error: { code: -32603, message: (e as Error).message } })); }
      });
    }, async close() { if (!closed) { closed = true; wire.onClose(); } },
  };
  return new RpcClient(wire);
}
function saved(store: MachineStore, name = "remote") { return store.save({ name, host: `owner@${name}`, platform: "linux", root: "/home/fixture/.rigwell/remote/aaaaaaaaaaaaaaaa", build, version: "old" }); }
async function failure(run: () => Promise<unknown>) { try { await run(); return "no failure"; } catch (e) { return (e as Error).message; } }

test("fleet status records verified last seen and keeps offline status unknown instead of zero", async () => {
  const env = tmpEnv(), store = new MachineStore(); saved(store); saved(store, "offline"); let offline = false, closed = 0;
  const fleet = new MachineFleet({ store, now: () => new Date("2026-11-14T10:00:00Z"), connect: async (name) => {
    if (name === "offline" || offline) throw new Error("Host key verification failed");
    const c = channel(() => info); c.onClose = () => closed++; return c;
  } });
  try {
    const rows = await fleet.list();
    expect(rows[0]).toMatchObject({ online: true, version: "0.1.0", runningSessions: 0, lastSeen: "2026-11-14T10:00:00.000Z", load: info.load });
    expect(rows[1]).toMatchObject({ online: false, runningSessions: null, load: null, error: "Host key verification failed" });
    expect(store.get("remote").lastSeen).toBe(rows[0]!.lastSeen!); expect(closed).toBe(1);
    offline = true; expect((await fleet.list())[0]).toMatchObject({ online: false, lastSeen: rows[0]!.lastSeen });
    fleet.remove("remote"); expect(store.list().map((m) => m.name)).toEqual(["offline"]);
  } finally { env.cleanup(); }
});

test("fleet restart waits for the verified shutdown acknowledgement and starts only its saved build", async () => {
  const env = tmpEnv(), store = new MachineStore(); saved(store); const events: string[] = [];
  const fleet = new MachineFleet({ store, connect: async () => channel((method, p) => { events.push(method); expect(p.build).toBe(build); return { shuttingDown: true }; }),
    run: async (_machine, command) => { events.push("start"); expect(command).toContain(build); expect(command).toContain("remote-start.ts"); expect(command).not.toContain("kill"); return { code: 0, stdout: JSON.stringify({ ...info, pid: 5678 }), stderr: "" }; },
  });
  try { expect((await fleet.restart("remote")).daemonPid).toBe(5678); expect(events).toEqual(["machine_shutdown", "start"]); }
  finally { env.cleanup(); }
});

test("busy update is refused before any bootstrap or replacement and explicit stop is routed", async () => {
  const env = tmpEnv(), store = new MachineStore(); saved(store); let bootstraps = 0, stopped = false;
  const fleet = new MachineFleet({ store, connect: async () => channel((method) => {
    if (method === "machine_shutdown") throw new Error("Stop all running sessions first");
    stopped = method === "machine_stop_sessions"; return { runningSessions: 0, stopped: 2 };
  }), bootstrap: async () => { bootstraps++; return store.get("remote"); } });
  try { expect(await failure(() => fleet.update("remote"))).toContain("Stop all"); expect(bootstraps).toBe(0); expect(await fleet.stop("remote")).toMatchObject({ stopped: 2 }); expect(stopped).toBe(true); }
  finally { env.cleanup(); }
});

test("failed update recovers the previous build and bulk update continues past a failed host", async () => {
  const env = tmpEnv(), store = new MachineStore(); saved(store); store.save({ name: "new", host: "owner@new" }); let recovered = 0;
  const fleet = new MachineFleet({ store, connect: async () => channel(() => ({ shuttingDown: true })),
    bootstrap: async (name) => { if (name === "remote") throw new Error("transfer failed"); return store.save({ ...store.get(name), build, version: "new" }, true); },
    run: async () => { recovered++; return { code: 0, stdout: JSON.stringify(info), stderr: "" }; },
  });
  try {
    const result = await fleet.updateAll(); expect(result.results[0]).toMatchObject({ name: "remote", error: "transfer failed" });
    expect(result.results[1]?.machine?.version).toBe("new"); expect(recovered).toBe(1); expect(store.get("remote").build).toBe(build);
  } finally { env.cleanup(); }
});
