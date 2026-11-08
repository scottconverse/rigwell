// Startup with hundreds of MCP tools and many custom models: parallel connect, cached tool lookup, end-to-end smoke.
// Bounds are generous (the old code is far above them, a slow CI runner far below).
import { expect, test } from "bun:test";
import { McpManager, type McpServerConfig } from "../../src/mcp/index.ts";
import type { McpClient } from "../../src/mcp/client.ts";
import { manyTools } from "../fakes/fake-mcp-many.ts";
import { runStartupCase } from "../../perf/bench-startup.ts";

const cfg = (name: string): McpServerConfig => ({ name, type: "stdio", command: "x", args: [], env: {}, source: "session" });

function fakeClient(c: McpServerConfig, perServer: number, delayMs: number): McpClient & { onClose?: (r: string) => void } {
  return {
    connect: async () => { await Bun.sleep(delayMs); },
    listTools: async () => manyTools(perServer, c.name),
    close: async () => {},
    callTool: async () => ({ text: "ok", isError: false, content: [] }),
  } as unknown as McpClient;
}

test("servers that each take 200 ms connect in parallel, not one after another", async () => {
  const mgr = new McpManager({ clientCtor: (c) => fakeClient(c, 10, 200) });
  const t0 = performance.now();
  await mgr.start(Array.from({ length: 10 }, (_, i) => cfg(`s${i}`)));
  const took = performance.now() - t0;
  expect(mgr.listServers().summary.connected).toBe(10);
  expect(took).toBeLessThan(1000); // one after another would be at least 2000
  await mgr.shutdown();
});

test("tool list and lookup are cached, keep order and names, and follow changes", async () => {
  const clients = new Map<string, McpClient & { onClose?: (r: string) => void }>();
  const mgr = new McpManager({
    reconnectDelayMs: 60_000,
    clientCtor: (c) => { const k = fakeClient(c, 600, 0); clients.set(c.name, k); return k; },
  });
  await mgr.start(Array.from({ length: 5 }, (_, i) => cfg(`s${i}`)));
  const list = mgr.tools();
  expect(list).toHaveLength(3000);
  expect(list[0]!.llmName).toBe("s0__s0_0");
  expect(list[3000 - 1]!.llmName).toBe("s4__s4_599");
  expect(list[601]!.bindingName).toBe("s1.s1_1");
  // both spellings find the same tool
  expect(mgr.findTool("s3__s3_42")!).toBe(mgr.findTool("s3.s3_42")!);
  expect(mgr.findTool("s3__s3_42")!.tool).toBe("s3_42");
  expect(mgr.findTool("nope")).toBeUndefined();
  // callers may mutate the array they got without corrupting the cache
  list.length = 0;
  expect(mgr.tools()).toHaveLength(3000);

  // 20000 lookups over 3000 tools: the old per-lookup rebuild of the whole list took seconds
  const t0 = performance.now();
  for (let i = 0; i < 20_000; i++) mgr.findTool(`s${i % 5}__s${i % 5}_${i % 600}`);
  expect(performance.now() - t0).toBeLessThan(1000);

  // a dropped server contributes nothing, at once
  clients.get("s2")!.onClose!("gone");
  expect(mgr.tools()).toHaveLength(2400);
  expect(mgr.findTool("s2__s2_1")).toBeUndefined();
  expect(mgr.findTool("s1__s1_1")).toBeDefined();
  // removing a server's entry (restart) drops it too
  await mgr.shutdown();
  expect(mgr.tools()).toHaveLength(0);
  expect(mgr.findTool("s1__s1_1")).toBeUndefined();
});

test("end to end: 100 MCP tools and 50 custom models give a ready session and a small first request", async () => {
  const r = await runStartupCase({ tools: 100, models: 50 }, { turns: 2 });
  expect(r.servers).toBe(5);
  expect(r.readyMs).toBeLessThan(15_000);
  expect(r.firstReqMs).toBeLessThan(15_000);
  // deferred tools are announced by name only: 100 schemas must not be in the first request
  expect(r.reqKB).toBeLessThan(120);
}, 60_000);
