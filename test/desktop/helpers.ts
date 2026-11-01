// Helpers for the desktop-side service tests: an in-process daemon and raw protocol clients (no Electron).
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import type { SidePaneOptions } from "../../src/sidepane/index.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { makeHome } from "../e2e/helpers.ts";

export const MODEL = "custom:Fake-Anthropic-0";

export async function startTestDaemon(url: string, sidepane?: SidePaneOptions, ws: false | { port: number } = false) {
  const home = makeHome([{ provider: "anthropic", url, displayName: "Fake Anthropic" }]);
  process.env.RIGWELL_HOME = home;
  const dir = mkdtempSync(join(tmpdir(), "rigwell-desk-sock-"));
  const d = await startDaemon({ socketPath: join(dir, "d.sock"), automations: false, ws, sidepane: sidepane ?? {} });
  return { d, home };
}

export interface TestClient {
  rpc: RpcClient;
  notes: any[];
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  waitFor(pred: (n: any) => boolean, ms?: number): Promise<any>;
  close(): Promise<void>;
}

/** One connection to the daemon. Permission requests are answered with proceed_once. */
export async function connect(socketPath: string): Promise<TestClient> {
  const rpc = new RpcClient(await SocketTransport.connect(socketPath));
  const notes: any[] = [];
  const waiters: { pred: (n: any) => boolean; resolve: (n: any) => void }[] = [];
  rpc.onNotification = (method, params) => {
    if (method !== "session_notification") return;
    const n = params.notification;
    notes.push(n);
    for (const w of [...waiters]) if (w.pred(n)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(n); }
  };
  rpc.onRequest = (method) => {
    if (method === "request_permission") return { selectedOption: "proceed_once" };
    return {};
  };
  return {
    rpc, notes,
    call: (m, p) => rpc.request(m, p),
    waitFor(pred, ms = 15_000) {
      const hit = notes.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timed out waiting for notification")), ms);
        waiters.push({ pred, resolve: (n) => { clearTimeout(t); resolve(n); } });
      });
    },
    close: () => rpc.close(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Playwright is not a project dependency; the sandbox has it under /opt/node-tools. Null when missing. */
export function loadPlaywright(): any | null {
  for (const base of ["/opt/node-tools/", process.cwd() + "/"]) {
    try { return createRequire(base)("playwright"); } catch {}
  }
  return null;
}
