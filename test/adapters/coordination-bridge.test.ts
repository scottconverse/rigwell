import { expect, test } from "bun:test";
import { startCoordinationBridge } from "../../src/adapters/coordination-bridge.ts";

test("coordination capability exposes only current tools, rejects RPC and cross-origin calls, and expires", async () => {
  let available = true, calls = 0;
  const controller = new AbortController();
  const tool = { name: "ListAgents", description: "roster", inputSchema: { type: "object" } };
  const bridge = startCoordinationBridge({ tools: () => available ? [tool, { ...tool, name: "answer_request" }] : [],
    async call(name, input) { calls++; expect(name).toBe("ListAgents"); return { content: JSON.stringify(input) }; } }, controller.signal);
  const send = (method: string, params = {}, headers = {}) => fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}`, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  try {
    expect((await send("tools/list", {}, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send("tools/list", {}, { origin: "http://localhost" })).status).toBe(403);
    expect((await (await send("initialize")).json()).result.capabilities.tools).toEqual({});
    expect((await (await send("tools/list")).json()).result.tools.map((t: any) => t.name)).toEqual(["ListAgents"]);
    expect((await (await send("answer_request")).json()).error.code).toBe(-32601);
    expect((await (await send("tools/call", { name: "Execute" })).json()).error.code).toBe(-32602);
    expect((await (await send("tools/call", { name: "ListAgents", arguments: { status: "idle" } })).json()).result.content[0].text).toContain("idle");
    available = false;
    expect((await (await send("tools/call", { name: "ListAgents" })).json()).error.code).toBe(-32602);
    expect(calls).toBe(1);
  } finally { await bridge.close(); }
  expect(await send("tools/list").then(() => false, () => true)).toBe(true);
});

test("closing coordination aborts an in-flight listener and awaits its release", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let released = false;
  const bridge = startCoordinationBridge({ tools: () => [{ name: "WaitForEvents", description: "wait", inputSchema: { type: "object" } }],
    async call(_name, _input, signal) { started(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); released = true; return { content: "cancelled" }; } }, new AbortController().signal);
  const pending = fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "WaitForEvents" } }) }).catch(() => undefined);
  await ready; await bridge.close(); await pending;
  expect(released).toBe(true);
});
