// MCP client manager (spec §5.7, §3.1.5 MCP methods, §3.1.6 shapes, §6.2 deferral). Standalone; the lead wires it in.
//
// Integration:
//   - Session start (initialize_session / load_session): `mcp = new McpManager({cwd, onStatusChanged: (i) =>
//     notify({type:"mcp_status_changed", ...})})`, then `void mcp.startFromConfig(fromInitConfigs(params.mcpServers))`.
//     Do NOT await it before turn 1 (servers start in parallel with the first turn). Call `mcp.shutdown()` on close_session.
//   - Protocol methods: list_mcp_servers => `mcp.listServers()` ({servers, summary}); add_mcp_server =>
//     `await mcp.addServer(params)` => {success}; remove_mcp_server => `await mcp.removeServer(serverName, settingsLevel)`.
//     Throw/translate Errors to an RPC error (InvalidParams for config errors).
//   - Tool discovery (spec §6.2, never edit the tools array mid-session): MCP tools are DEFERRED. Announce
//     `mcp.tools().map(t => t.llmName)` as names only in an appended reminder message, and again as deltas when
//     `onStatusChanged` shows tools appearing/disappearing (compare `mcp.tools()` snapshots). When `load_tools` returns
//     them, append the signatures (`description`, `inputSchema`) and make them callable: direct mode through
//     `call_tool({name, args})`, Script mode as `tools.<server>.<tool>` (`bindingName`).
//   - Execution: `await mcp.callTool(llmName, input, {signal})` -> {text, isError}. Map `text` to the tool_result
//     content and `isError` to tool_result isError. Permission: confirmationType `mcp_tool` with details
//     {toolName: llmName, serverName: t.server, actualToolName: t.tool, impactLevel}; use `mcp.findTool(name)` to resolve.
//   - A server that connects and drops 6+ times is reported status "failed" with a "suppressed" error and contributes no tools.
//   - OAuth is NOT implemented (spec lists it as later): a 401/403 from an http server fails with a clear message;
//     use `headers` for tokens.
export * from "./types.ts";
export * from "./config.ts";
export { McpClient, contentToText, MCP_PROTOCOL_VERSION } from "./client.ts";
export { McpManager, mcpLlmName, mcpBindingName, MAX_DROPS } from "./manager.ts";
export type { McpManagerOptions } from "./manager.ts";
export { createConnection, McpRpcError } from "./transport.ts";
