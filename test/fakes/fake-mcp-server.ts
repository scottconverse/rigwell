#!/usr/bin/env bun
// Tiny fake MCP server over stdio (newline-delimited JSON-RPC). Run: bun fake-mcp-server.ts
// Env: FAKE_MCP_NAME, FAKE_MCP_CRASH_AFTER_MS (exit after initialize), FAKE_MCP_EXIT_ON_START=1, FAKE_MCP_INIT_DELAY_MS.
import { appendFileSync } from "node:fs";
import { handleMcpRequest } from "./fake-mcp-core.ts";

if (process.env.FAKE_MCP_EXIT_ON_START) { console.error("fake mcp: refusing to start"); process.exit(3); }
let buf = "";
process.stdin.on("data", async (d) => {
  buf += d.toString();
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    // FAKE_MCP_LOG=<file>: every tools/call request is appended as one JSON line, so tests can see what reached the server.
    if (process.env.FAKE_MCP_LOG && msg.method === "tools/call") appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(msg.params) + "\n");
    if (msg.method === "initialize" && process.env.FAKE_MCP_INIT_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_MCP_INIT_DELAY_MS));
    const res = handleMcpRequest(msg, process.env.FAKE_MCP_NAME ?? "fake");
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
    if (msg.method === "notifications/initialized" && process.env.FAKE_MCP_CRASH_AFTER_MS) {
      setTimeout(() => process.exit(1), Number(process.env.FAKE_MCP_CRASH_AFTER_MS));
    }
  }
});
