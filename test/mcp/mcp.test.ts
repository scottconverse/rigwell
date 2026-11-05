import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startFakeMcpHttp } from "../fakes/fake-mcp-http.ts";
import {
  McpManager, fromInitConfigs, loadMcpConfig, mcpBindingName, mcpLlmName, type McpServerConfig, type McpServerStatusInfo,
} from "../../src/mcp/index.ts";

const FAKE = path.resolve(import.meta.dir, "../fakes/fake-mcp-server.ts");
let env: ReturnType<typeof tmpEnv>;
let proj: string;
let mgr: McpManager | undefined;
beforeEach(() => { env = tmpEnv(); proj = path.join(env.root, "proj"); mkdirSync(path.join(proj, ".git"), { recursive: true }); });
afterEach(async () => { await mgr?.shutdown(); mgr = undefined; env.cleanup(); });

const stdio = (name: string, e: Record<string, string> = {}): McpServerConfig =>
  ({ name, type: "stdio", command: process.execPath, args: [FAKE], env: { FAKE_MCP_NAME: name, ...e }, source: "session" });

test("naming", () => {
  expect(mcpLlmName("my server", "do-it")).toBe("my_server__do-it");
  expect(mcpBindingName("fs", "read")).toBe("fs.read");
});

test("stdio: connect, paginated tools, call, content to text, isError", async () => {
  const changes: McpServerStatusInfo[] = [];
  mgr = new McpManager({ cwd: proj, onStatusChanged: (i) => changes.push(i) });
  const p = mgr.start([stdio("a")]);
  expect(mgr.listServers().summary).toMatchObject({ total: 1, connecting: 1, connected: 0 });
  await p;
  const { servers, summary } = mgr.listServers();
  expect(summary).toMatchObject({ total: 1, connected: 1, failed: 0 });
  expect(servers[0]).toMatchObject({ name: "a", status: "connected", toolCount: 4, serverType: "stdio", isManaged: false });
  expect(changes.map((c) => c.status)).toEqual(["connecting", "connected"]);
  expect(mgr.tools().map((t) => t.llmName)).toEqual(["a__echo", "a__add", "a__fail", "a__mixed"]);
  expect((await mgr.callTool("a__echo", { text: "hi" })).text).toBe("hi");
  expect((await mgr.callTool("a.add", { a: 2, b: 3 })).text).toBe("5");
  const f = await mgr.callTool("a__fail", {});
  expect(f).toMatchObject({ isError: true, text: "it broke" });
  const m = await mgr.callTool("a__mixed", {});
  expect(m.text).toBe("line1\n[image: image/png, 4 base64 chars]\ninline resource\n[resource: file:///y]");
  await expect(mgr.callTool("a__nope", {})).rejects.toThrow("not available");
});

test("servers start in parallel; a failing one does not block others", async () => {
  mgr = new McpManager({ cwd: proj });
  const t0 = Date.now();
  await mgr.start([
    stdio("slow1", { FAKE_MCP_INIT_DELAY_MS: "600" }), stdio("slow2", { FAKE_MCP_INIT_DELAY_MS: "600" }),
    stdio("bad", { FAKE_MCP_EXIT_ON_START: "1" }), { ...stdio("off"), disabled: true },
  ]);
  expect(Date.now() - t0).toBeLessThan(1150);
  const { servers, summary } = mgr.listServers();
  expect(summary).toMatchObject({ total: 4, connected: 2, failed: 1, disabled: 1 });
  const bad = servers.find((s) => s.name === "bad")!;
  expect(bad.status).toBe("failed");
  expect(bad.error).toContain("refusing to start");
  expect(mgr.tools().every((t) => t.server.startsWith("slow"))).toBe(true);
});

test("connect timeout marks failed", async () => {
  mgr = new McpManager({ cwd: proj, connectTimeoutMs: 200 });
  await mgr.start([stdio("hang", { FAKE_MCP_INIT_DELAY_MS: "3000" })]);
  expect(mgr.listServers().servers[0]).toMatchObject({ status: "failed" });
  expect(mgr.listServers().servers[0].error).toContain("timed out");
});

test("http json, http sse, legacy sse, headers", async () => {
  const j = startFakeMcpHttp("json", { requireHeader: ["authorization", "Bearer t"] });
  const s = startFakeMcpHttp("sse");
  const l = startFakeMcpHttp("legacy");
  try {
    mgr = new McpManager({ cwd: proj });
    const mk = (name: string, type: "http" | "sse", url: string, headers = {}): McpServerConfig => ({ name, type, url, headers, source: "session" });
    await mgr.start([mk("j", "http", j.url, { authorization: "Bearer t" }), mk("s", "http", s.url), mk("l", "sse", l.url), mk("noauth", "http", j.url)]);
    const st = Object.fromEntries(mgr.listServers().servers.map((x) => [x.name, x]));
    expect(st.j.status).toBe("connected");
    expect(st.s.status).toBe("connected");
    expect(st.l.status).toBe("connected");
    expect(st.noauth.status).toBe("failed");
    expect(st.noauth.error).toContain("Sign-in needed");
    expect((await mgr.callTool("j__echo", { text: "J" })).text).toBe("J");
    expect((await mgr.callTool("s__echo", { text: "S" })).text).toBe("S");
    expect((await mgr.callTool("l__echo", { text: "L" })).text).toBe("L");
    expect(j.seenHeaders.some((h) => h["mcp-session-id"] === "sess-1")).toBe(true);
  } finally { await mgr?.shutdown(); mgr = undefined; j.stop(); s.stop(); l.stop(); }
});

test("connects and drops 6 times => suppressed", async () => {
  mgr = new McpManager({ cwd: proj, reconnectDelayMs: 10 });
  await mgr.start([stdio("flaky", { FAKE_MCP_CRASH_AFTER_MS: "30" })]);
  expect(mgr.listServers().servers[0].status).toBe("connected");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = mgr.listServers().servers[0];
    if (s.status === "failed") break;
    await Bun.sleep(50);
  }
  const s = mgr.listServers().servers[0];
  expect(s.status).toBe("failed");
  expect(s.error).toContain("suppressed");
  expect(s.error).toContain("6 times");
  expect(mgr.tools()).toEqual([]);
}, 20000);

test("config: mcp.json user + project, project wins, init configs, bare map, bad entry", () => {
  writeJson(path.join(env.rigwellHome, "mcp.json"), { mcpServers: { u: { command: "x", args: ["1"] }, both: { command: "user" } } });
  writeJson(path.join(proj, ".rigwell", "mcp.json"), { mcpServers: { both: { command: "proj" }, h: { url: "http://x/mcp", headers: { A: "b" } }, bad: { type: "stdio" } } });
  const c = loadMcpConfig({ cwd: proj, homeDir: env.home });
  const by = Object.fromEntries(c.servers.map((s) => [s.name, s]));
  expect(Object.keys(by).sort()).toEqual(["both", "h", "u"]);
  expect(by.both).toMatchObject({ command: "proj", source: "project", type: "stdio" });
  expect(by.h).toMatchObject({ type: "http", url: "http://x/mcp", headers: { A: "b" } });
  expect(by.u).toMatchObject({ source: "user", args: ["1"], env: {} });
  expect(c.warnings.some((w) => w.includes('"bad"'))).toBe(true);
  const init = fromInitConfigs([
    { name: "i1", command: "node", args: ["a"], env: { K: "V" } },
    { type: "http", name: "i2", url: "http://y", headers: [{ name: "X", value: "1" }] },
  ]);
  expect(init[0]).toMatchObject({ name: "i1", type: "stdio", env: { K: "V" } });
  expect(init[1]).toMatchObject({ name: "i2", type: "http", headers: { X: "1" } });
});

test("add_mcp_server / remove_mcp_server persist to the user mcp.json", async () => {
  mgr = new McpManager({ cwd: proj });
  expect(await mgr.addServer({ name: "added", type: "stdio", command: process.execPath, args: [FAKE] })).toEqual({ success: true });
  expect(mgr.listServers().servers[0]).toMatchObject({ name: "added", status: "connected", source: "user" });
  expect(loadMcpConfig({ cwd: proj, homeDir: env.home }).servers.map((s) => s.name)).toEqual(["added"]);
  await expect(mgr.addServer({ name: "x", type: "stdio" })).rejects.toThrow("command");
  expect(await mgr.removeServer("added", "user")).toEqual({ success: true });
  expect(mgr.listServers().summary.total).toBe(0);
  expect(loadMcpConfig({ cwd: proj, homeDir: env.home }).servers).toEqual([]);
  expect(await mgr.removeServer("added", "user")).toEqual({ success: false });
});

test("startFromConfig: init servers override file servers of the same name", async () => {
  writeJson(path.join(env.rigwellHome, "mcp.json"), { mcpServers: { dup: { command: "does-not-exist-xyz" } } });
  mgr = new McpManager({ cwd: proj });
  await mgr.startFromConfig([stdio("dup")]);
  expect(mgr.listServers().servers[0]).toMatchObject({ name: "dup", status: "connected" });
});
