// One MCP client: initialize, tools/list, tools/call over a Connection.
import { McpAuthRequiredError } from "./oauth.ts";
import { createConnection, McpRpcError, type Connection } from "./transport.ts";
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Flatten MCP content blocks to text (spec: content blocks to text). */
export function contentToText(content: unknown, structured?: unknown): string {
  const parts: string[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, any>;
    switch (blk.type) {
      case "text": parts.push(String(blk.text ?? "")); break;
      case "image": parts.push(`[image: ${blk.mimeType ?? "unknown type"}, ${String(blk.data ?? "").length} base64 chars]`); break;
      case "audio": parts.push(`[audio: ${blk.mimeType ?? "unknown type"}]`); break;
      case "resource_link": parts.push(`[resource: ${blk.uri ?? blk.name ?? ""}${blk.description ? " - " + blk.description : ""}]`); break;
      case "resource": {
        const r = blk.resource ?? {};
        parts.push(typeof r.text === "string" ? r.text : `[resource: ${r.uri ?? ""}${r.mimeType ? " (" + r.mimeType + ")" : ""}]`);
        break;
      }
      default: parts.push(JSON.stringify(blk));
    }
  }
  if (!parts.length && structured !== undefined) return JSON.stringify(structured);
  return parts.join("\n");
}

export class McpClient {
  private conn: Connection;
  serverInfo?: { name?: string; version?: string };
  /** Fires when the transport drops on its own after connect. */
  onClose?: (reason: string) => void;

  constructor(public cfg: McpServerConfig, opts: { cwd?: string; connection?: Connection } = {}) {
    this.conn = opts.connection ?? createConnection(cfg, opts.cwd);
    this.conn.onClose = (r) => this.onClose?.(r);
  }

  /** Start the transport and run the initialize handshake. */
  async connect(timeoutMs = 30000): Promise<void> {
    try {
      await this.conn.start();
      const r = await this.conn.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "rigwell", version: "0.3.2" },
      }, timeoutMs);
      this.serverInfo = r?.serverInfo;
      await this.conn.notify("notifications/initialized");
    } catch (e) {
      const tail = this.conn.stderrTail?.();
      await this.conn.close().catch(() => {});
      if (e instanceof McpAuthRequiredError) throw e; // the manager shows "sign-in needed" for it
      const msg = (e as Error).message;
      throw new McpRpcError(tail && !msg.includes(tail) ? `${msg}: ${tail}` : msg);
    }
  }

  async listTools(timeoutMs = 30000): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.conn.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      for (const t of r?.tools ?? []) if (t && typeof t.name === "string") out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpCallResult> {
    const r = await this.conn.request("tools/call", { name, arguments: args }, opts.timeoutMs ?? 300000, opts.signal);
    return { text: contentToText(r?.content, r?.structuredContent), isError: r?.isError === true, content: r?.content ?? [] };
  }

  close(): Promise<void> { return this.conn.close(); }
}
