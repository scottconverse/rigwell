// An MCP tool as a deferred Tool (spec 6.2): named server__tool, callable as tools.server.tool inside a Script.
import type { Tool } from "../core/types.ts";
import type { McpManager } from "./manager.ts";
import type { McpToolInfo } from "./types.ts";

export function mcpTool(mgr: McpManager, info: McpToolInfo): Tool {
  return {
    name: info.llmName,
    description: info.description || `${info.tool} (MCP server ${info.server})`,
    inputSchema: info.inputSchema,
    category: "other",
    run: async (input, ctx) => {
      try {
        const r = await mgr.callTool(info.llmName, input, { signal: ctx.signal });
        return { content: r.text, isError: r.isError };
      } catch (e) {
        return { content: `MCP tool ${info.llmName} failed: ${(e as Error)?.message ?? e}`, isError: true };
      }
    },
  };
}
