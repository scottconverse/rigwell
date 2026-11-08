#!/usr/bin/env bun
// Fake MCP server (stdio) that exposes many tools with realistic JSON schemas. Used by the startup benchmark and tests.
// Env: FAKE_MCP_NAME, FAKE_MCP_TOOLS (count, default 100), FAKE_MCP_INIT_DELAY_MS, FAKE_MCP_PAGE (tools per tools/list page, default 100).
import { handleMcpRequest } from "./fake-mcp-core.ts";

export function manyTools(n: number, prefix = "tool"): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix}_${i}`,
    description: `Operation ${i} of the ${prefix} service. Looks up, filters and returns records; supports pagination and sorting.\nSecond line with more detail about tool ${i}.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record identifier" },
        query: { type: "string", description: "Free text filter" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Page size" },
        cursor: { type: "string" },
        sort: { type: "string", enum: ["asc", "desc"] },
        fields: { type: "array", items: { type: "string" }, description: "Fields to return" },
        options: { type: "object", properties: { deep: { type: "boolean" }, timeoutMs: { type: "number" }, tags: { type: "array", items: { type: "string" } } }, additionalProperties: false },
      },
      required: ["id"],
      additionalProperties: false,
    },
  }));
}

if (import.meta.main) {
  const name = process.env.FAKE_MCP_NAME ?? "many";
  const tools = manyTools(Number(process.env.FAKE_MCP_TOOLS ?? 100), name.replace(/\W/g, "_"));
  const page = Number(process.env.FAKE_MCP_PAGE ?? 100);
  let buf = "";
  process.stdin.on("data", async (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize" && process.env.FAKE_MCP_INIT_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_MCP_INIT_DELAY_MS));
      if (msg.method === "tools/list") {
        const start = msg.params?.cursor ? Number(msg.params.cursor) : 0;
        const end = Math.min(tools.length, start + page);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: String(end) } : {}) } }) + "\n");
        continue;
      }
      const res = handleMcpRequest(msg, name);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
}
