// Phase 5 done-when (spec 9, row 5): the SDK runs a multi-turn session with a custom MCP tool.
// Turn 1: the model loads the MCP tool (load_tools, direct mode) and calls it (call_tool).
// Turn 2: the model calls it inside a Script as tools.fake.echo. The fake MCP server (stdio) logs what reaches it.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { lastToolResult, makeHome, makeRepo } from "./helpers.ts";
import { createSession, type PermissionRequest } from "../../src/sdk/index.ts";

const FAKE_MCP = path.resolve(import.meta.dir, "../fakes/fake-mcp-server.ts");
const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const flat = (body: any) => JSON.stringify(body.messages ?? []);

const script = (): FakeTurn[] => [
  // turn 1, request 1: the deferred tool is announced by name only; load it
  (body) => {
    if (!flat(body).includes("fake__echo")) throw new Error("the MCP tool was not announced to the model");
    if ((body.tools ?? []).some((t: any) => t.name === "fake__echo")) throw new Error("an MCP tool must not be in the tools array");
    return { toolCalls: [{ name: "load_tools", input: { names: ["fake__echo"] } }] };
  },
  // request 2: the load result carries the signature; call it
  (body) => {
    if (!lastToolResult(body).includes("fake__echo")) throw new Error("load_tools result missing: " + lastToolResult(body));
    if (!flat(body).includes("echo({ text: string })")) throw new Error("signature reminder missing");
    return { toolCalls: [{ name: "call_tool", input: { name: "fake__echo", args: { text: "hello from turn one" } } }] };
  },
  // request 3: the MCP result reached the model
  (body) => {
    if (lastToolResult(body) !== "hello from turn one") throw new Error("MCP result not sent to the model: " + lastToolResult(body));
    return { text: "Turn one: the server said hello from turn one." };
  },
  // turn 2, request 4: call the loaded tool from a Script as tools.fake.echo
  (body) => {
    if (!flat(body).includes("Turn one: the server said")) throw new Error("history missing");
    return { toolCalls: [{ name: "Script", input: { script: "const r = await tools.fake.echo({ text: 'from the script' });\nprint('got', r.text);" } }] };
  },
  // request 5: the Script printed what the server returned
  (body) => {
    const j = JSON.parse(lastToolResult(body));
    if (j.status !== "completed" || !j.output.includes("got from the script")) throw new Error("Script result: " + lastToolResult(body));
    return { text: "Turn two: the script reached the server." };
  },
];

test("SDK: two turns, a custom MCP tool loaded in turn 1 and called from a Script in turn 2", async () => {
  const model = await startFakeAnthropic(script());
  servers.push(model);
  const repo = makeRepo();
  const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }]);
  const dir = mkdtempSync(path.join(tmpdir(), "rigwell-mcp-e2e-"));
  const log = path.join(dir, "mcp.log");
  writeFileSync(log, "");

  const asked: PermissionRequest[] = [];
  const events: any[] = [];
  const session = await createSession({
    cwd: repo, env: { RIGWELL_HOME: home }, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "low",
    initParams: { mcpServers: [{ name: "fake", command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_LOG: log } }] },
    onNotification: (n) => events.push(n),
    onPermission: (req) => {
      asked.push(req);
      // First call: allow once. Second call (inside the Script): remember the tool.
      return { selectedOption: asked.length === 1 ? "proceed_once" : "proceed_always_tools" };
    },
  });

  // The servers start in parallel with the session; wait until this one is up before the first turn.
  for (let i = 0; i < 200; i++) {
    const r = await session.call<any>("list_mcp_servers");
    if (r.summary.connected === 1) { expect(r.servers[0]).toMatchObject({ name: "fake", status: "connected", toolCount: 4 }); break; }
    if (i === 199) throw new Error("MCP server did not connect: " + JSON.stringify(r));
    await Bun.sleep(25);
  }
  expect(events.some((e) => e.type === "mcp_status_changed" && e.server.status === "connected")).toBe(true);

  const t1 = await session.send("Say hello through the fake server.").done;
  expect(t1.reason).toBe("completed");
  expect(t1.text).toContain("hello from turn one");
  expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ name: "echo", arguments: { text: "hello from turn one" } }]);

  const t2 = await session.send("Now do it from a script.").done;
  expect(t2.reason).toBe("completed");
  expect(t2.text).toContain("the script reached the server");
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(calls).toEqual([
    { name: "echo", arguments: { text: "hello from turn one" } },
    { name: "echo", arguments: { text: "from the script" } },
  ]);

  // Each MCP call asked (mcp_tool), with the options of spec 5.5.5; the second answer was remembered in settings.
  expect(asked.length).toBe(2);
  expect(asked[0]!.toolUses[0]).toMatchObject({ confirmationType: "mcp_tool", details: { toolName: "fake__echo", serverName: "fake", actualToolName: "echo" } });
  expect(asked[0]!.options.map((o) => o.value)).toEqual(["proceed_once", "proceed_always_tools", "proceed_always_server", "cancel"]);
  const saved = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  expect(saved.mcpAlwaysAllow.tools).toHaveProperty("fake__echo");
  expect(model.requests.length).toBe(5);
  await session.close();
  expect(existsSync(log)).toBe(true);
}, 60000);
