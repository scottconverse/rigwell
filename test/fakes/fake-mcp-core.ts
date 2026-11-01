// Shared JSON-RPC handler for the fake MCP servers (stdio and HTTP).
export const FAKE_TOOLS = [
  { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  { name: "fail", description: "Always returns isError", inputSchema: { type: "object", properties: {} } },
  { name: "mixed", description: "Returns several block kinds", inputSchema: { type: "object", properties: {} } },
];

/** Returns the JSON-RPC response for a request, or null for notifications. */
export function handleMcpRequest(msg: any, serverName = "fake"): object | null {
  if (msg.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: serverName, version: "1.0.0" } });
    case "tools/list": {
      // two pages to exercise pagination
      if (!msg.params?.cursor) return ok({ tools: FAKE_TOOLS.slice(0, 2), nextCursor: "p2" });
      return ok({ tools: FAKE_TOOLS.slice(2) });
    }
    case "tools/call": {
      const { name, arguments: a = {} } = msg.params ?? {};
      if (name === "echo") return ok({ content: [{ type: "text", text: String(a.text) }] });
      if (name === "add") return ok({ content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }] });
      if (name === "fail") return ok({ content: [{ type: "text", text: "it broke" }], isError: true });
      if (name === "mixed") return ok({ content: [
        { type: "text", text: "line1" }, { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "resource", resource: { uri: "file:///x", text: "inline resource" } },
        { type: "resource_link", uri: "file:///y", name: "y" },
      ] });
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    case "ping": return ok({});
    default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}
