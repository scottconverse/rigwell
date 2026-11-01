// MCP shapes (spec §3.1.5, §3.1.6).
export type McpTransportType = "stdio" | "http" | "sse";
export type McpSource = "user" | "project" | "folder" | "runtime" | "session";

/** Internal normalized server config. */
export interface McpServerConfig {
  name: string;
  type: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth is not built (spec lists it as later); kept so the field round-trips. */
  oauth?: false | Record<string, unknown>;
  disabled?: boolean;
  source: McpSource;
}

/** Wire shape of a server in initialize_session / load_session (spec §3.1.6). */
export type McpServerInitConfig =
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; name: string; url: string; headers?: { name: string; value: string }[]; oauth?: unknown };

/** Params of add_mcp_server (spec §3.1.5). */
export interface AddMcpServerParams {
  name: string;
  type: McpTransportType;
  url?: string;
  headers?: Record<string, string>;
  oauth?: false | Record<string, unknown>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpStatus = "connecting" | "connected" | "disconnected" | "failed" | "disabled";

export interface McpServerStatusInfo {
  name: string;
  status: McpStatus;
  source: McpSource;
  isManaged: boolean;
  serverType: McpTransportType;
  displayName?: string;
  error?: string;
  toolCount?: number;
  requiresAuth?: boolean;
  hasAuthTokens?: boolean;
}

export interface McpStatusSummary {
  total: number;
  connected: number;
  connecting: number;
  failed: number;
  disabled?: number;
  configError?: { path: string; message: string };
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A discovered tool as the loop sees it. */
export interface McpToolInfo {
  server: string;
  /** Name on the server. */
  tool: string;
  /** Model-facing id: `server__tool`. */
  llmName: string;
  /** Script binding path: `server.tool` (used as `tools.server.tool`). */
  bindingName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** Content blocks flattened to text. */
  text: string;
  isError: boolean;
  /** Raw content blocks as returned by the server. */
  content: unknown[];
}
