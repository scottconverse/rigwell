import { timingSafeEqual, randomBytes } from "node:crypto";
import type { ModelRequest } from "../core/types.ts";

export const COORDINATION_TOOLS = new Set([
  "ProposeWorkstream", "SpawnAgent", "ListAgents", "SendMessage", "CreateListener",
  "WaitForEvents", "InterruptAgent", "RenameAgent", "ArchiveAgent", "AskUser",
  "Skill", "InstallLocalService",
  "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press",
  "browser_scroll", "browser_screenshot", "browser_wait", "browser_evaluate", "browser_close",
]);

/** A request-scoped capability, bound to the owning Session, never a daemon RPC proxy. */
export function startCoordinationBridge(host: NonNullable<NonNullable<ModelRequest["nativeExecution"]>["coordination"]>, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex");
  const controller = new AbortController();
  const calls = new Set<Promise<unknown>>();
  const combined = AbortSignal.any([signal, controller.signal]);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 256 * 1024, idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(req.headers.get("authorization") ?? "");
      if (combined.aborted || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response(null, { status: 401 });
      if (url.hostname !== "127.0.0.1" || req.headers.has("origin") || url.pathname !== "/mcp") return new Response(null, { status: 403 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      let msg: any;
      try { msg = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, { status: 400 }); }
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || Array.isArray(msg)) return new Response(null, { status: 400 });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      const error = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "rigwell", version: "1.0.0" } });
      if (msg.method === "ping") return reply({});
      if (msg.method === "tools/list") return reply({ tools: host.tools().filter((t) => COORDINATION_TOOLS.has(t.name)) });
      if (msg.method !== "tools/call") return error(-32601, "Method not available");
      if (calls.size >= 16) return error(-32000, "Too many active coordination calls");
      const name = msg.params?.name, input = msg.params?.arguments ?? {};
      if (!COORDINATION_TOOLS.has(name) || !host.tools().some((t) => t.name === name)) return error(-32602, "Tool not available in this session");
      if (!input || typeof input !== "object" || Array.isArray(input)) return error(-32602, "Tool arguments must be an object");
      const task = Promise.resolve().then(() => host.call(name, input, AbortSignal.any([combined, req.signal])));
      calls.add(task);
      try {
        const out = await task;
        return reply({ content: [{ type: "text", text: out.content }], ...(out.isError ? { isError: true } : {}) });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      } finally { calls.delete(task); }
    },
  });
  const abort = () => { controller.abort(); void server.stop(true); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { url: `http://127.0.0.1:${server.port}/mcp`, token,
    async close() { signal.removeEventListener("abort", abort); controller.abort(); await server.stop(true); await Promise.allSettled([...calls]); } };
}
