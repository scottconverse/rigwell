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
      if (msg.method === "tools/list") return reply({ tools: [...host.tools().filter((t) => COORDINATION_TOOLS.has(t.name)), ...(host.requestNativePermission ? [{ name: "NativePermission", description: "Request user approval for a native client action. Does not execute tools.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name", "input"] } }] : [])] });
      if (msg.method !== "tools/call") return error(-32601, "Method not available");
      if (calls.size >= 16) return error(-32000, "Too many active coordination calls");
      const name = msg.params?.name, input = msg.params?.arguments ?? {};
      if (!input || typeof input !== "object" || Array.isArray(input)) return error(-32602, "Tool arguments must be an object");
      const permission = name === "NativePermission" && !!host.requestNativePermission;
      if (!permission && (!COORDINATION_TOOLS.has(name) || !host.tools().some((t) => t.name === name))) return error(-32602, "Tool not available in this session");
      if (permission && (typeof input.tool_name !== "string" || !input.tool_name.trim() || input.tool_name.length > 200 || !input.input || typeof input.input !== "object" || Array.isArray(input.input))) return error(-32602, "Invalid native permission request");
      const callSignal = AbortSignal.any([combined, req.signal]);
      const task = Promise.resolve().then(async () => {
        if (permission) {
          const decision = await host.requestNativePermission!(input.tool_name, input.input, callSignal);
          return { content: [{ type: "text", text: JSON.stringify(callSignal.aborted ? { behavior: "deny", message: "Approval cancelled" } : decision) }] };
        }
        const out = await host.call(name, input, callSignal);
        const context = !out.isError && !callSignal.aborted ? await host.takeWorkstreamContext?.(callSignal) ?? [] : [];
        return { content: [out.content, ...context].map((text) => ({ type: "text", text })), ...(out.isError ? { isError: true } : {}) };
      });
      calls.add(task);
      try {
        return reply(await task);
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
