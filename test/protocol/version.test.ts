// Protocol version check (spec 3.1.3): a different major gets an error with the Rigwell data fields.
import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, RpcPeer, majorOf, versionMismatch } from "../../src/protocol/rpc.ts";

function peer() {
  const out: any[] = [];
  const logs: string[] = [];
  const handled: string[] = [];
  const p = new RpcPeer((l) => out.push(JSON.parse(l)), async (m) => { handled.push(m); return { ok: true }; }, (m) => logs.push(m));
  return { p, out, logs, handled };
}
const line = (o: object) => JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n";

test("major and minor parsing", () => {
  expect(majorOf("1.2.3")).toBe(1);
  expect(majorOf("v2")).toBe(2);
  expect(majorOf("abc")).toBeUndefined();
  expect(versionMismatch("0.9.9")).toBe(false); // same major as 0.1.0
  expect(versionMismatch("1.0.0")).toBe(true);
  expect(versionMismatch("weird")).toBe(false); // unreadable: tolerated
});

test("a request with another major gets an error with the mismatch data and is not run", async () => {
  const { p, out, handled } = peer();
  p.feed(line({ type: "request", id: "r1", method: "rigwell.list_models", params: {}, protocolVersion: "9.0.0" }));
  await Bun.sleep(5);
  expect(handled).toEqual([]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ type: "response", id: "r1", error: { code: -32600 } });
  expect(out[0].error.data).toEqual({ localProtocolVersion: PROTOCOL_VERSION, peerProtocolVersion: "9.0.0", messageType: "request", method: "rigwell.list_models", requestId: "r1" });
});

test("minor and patch differences, and a missing version, are accepted", async () => {
  const { p, out, handled } = peer();
  p.feed(line({ type: "request", id: "a", method: "rigwell.x", params: {}, protocolVersion: "0.7.3" }));
  p.feed(line({ type: "request", id: "b", method: "rigwell.y", params: {} }));
  await Bun.sleep(5);
  expect(handled).toEqual(["x", "y"]);
  expect(out.every((m) => !m.error)).toBe(true);
});

test("a response with another major rejects the waiting request; a notification is dropped with a log", async () => {
  const { p, out, logs } = peer();
  const waiting = p.request("rigwell.request_permission", {});
  const id = out[0].id;
  p.feed(line({ type: "response", id, result: {}, protocolVersion: "2.0.0" }));
  await expect(waiting).rejects.toMatchObject({ code: -32600, data: { messageType: "response", requestId: id, peerProtocolVersion: "2.0.0" } });
  p.feed(line({ type: "notification", method: "rigwell.ping", params: {}, protocolVersion: "2.0.0" }));
  expect(logs.some((l) => l.includes("mismatch"))).toBe(true);
});
