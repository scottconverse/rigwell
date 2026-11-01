// WebSocket listener auth: loopback only, token required.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { makeHome } from "../e2e/helpers.ts";

let d: Awaited<ReturnType<typeof startDaemon>>;
let prev: string | undefined;
beforeAll(async () => {
  prev = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = makeHome([]);
  d = await startDaemon({ socketPath: join(mkdtempSync(join(tmpdir(), "rigwell-wsauth-")), "d.sock"), automations: false, ws: { port: 0 } });
});
afterAll(() => {
  d.stop();
  if (prev === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prev;
});

const httpUrl = (q = "") => d.wsUrl!.replace("ws://", "http://") + q;

function open(url: string, headers?: Record<string, string>): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new (WebSocket as any)(url, headers ? { headers } : undefined) as WebSocket;
    ws.onopen = () => { ws.close(); resolve("open"); };
    ws.onerror = () => resolve("rejected");
    ws.onclose = () => resolve("rejected");
  });
}

describe("WebSocket auth", () => {
  test("binds 127.0.0.1", () => {
    expect(new URL(d.wsUrl!).hostname).toBe("127.0.0.1");
  });
  test("no token: 401 and no upgrade", async () => {
    expect((await fetch(httpUrl(), { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(401);
    expect(await open(d.wsUrl!)).toBe("rejected");
  });
  test("wrong token: rejected", async () => {
    expect((await fetch(httpUrl("?token=nope"))).status).toBe(401);
    expect(await open(d.wsUrl! + "?token=nope")).toBe("rejected");
    expect(await open(d.wsUrl! + "?token=" + d.wsToken!.slice(0, -1))).toBe("rejected");
  });
  test("right token: accepted (query and bearer header)", async () => {
    expect(await open(d.wsUrl! + "?token=" + d.wsToken)).toBe("open");
    expect(await open(d.wsUrl!, { Authorization: "Bearer " + d.wsToken })).toBe("open");
  });
  test("non-loopback Host header is refused even with a good token", async () => {
    const r = await fetch(httpUrl("?token=" + d.wsToken), { headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
  });
  test("a frame is one JSON-RPC message", async () => {
    const ws = new WebSocket(d.wsUrl! + "?token=" + d.wsToken);
    const got = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "1", method: "rigwell.list_models", params: {} }));
      ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.close();
    expect(got.id).toBe("1");
    expect(got.result.models).toEqual([]);
  });
});
