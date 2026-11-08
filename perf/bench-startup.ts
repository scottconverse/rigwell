// Startup benchmark: many MCP tools (N) and many custom models (M). Run: bun perf/bench-startup.ts [--json] [--quick]
// Measures, over the in-process RPC (the same path the daemon uses):
//   readyMs      initialize_session round trip (session ready; MCP servers connect in the background)
//   connectedMs  from initialize_session start until every MCP server reported connected
//   firstReqMs   add_user_message until the model server receives the first request (tools and system prompt assembled)
//   turnMs       median of the next turns (per-turn overhead with the same tool set)
//   reqKB        size of the first request body
//   listToolsMs  the list_tools RPC after every server connected (what a client asks for to show the tool picker)
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startFakeAnthropic } from "../test/fakes/fake-anthropic.ts";
import { makeRepo } from "../test/e2e/helpers.ts";
import { median, round } from "./stats.ts";

const MANY = join(import.meta.dir, "../test/fakes/fake-mcp-many.ts");

export interface StartupCase { tools: number; models: number }
export interface StartupResult extends StartupCase { servers: number; readyMs: number; connectedMs: number; firstReqMs: number; turnMs: number; reqKB: number; listToolsMs: number }

export function makeHomeWithModels(url: string, models: number): { home: string; modelId: string } {
  const home = mkdtempSync(join(tmpdir(), "rigwell-startup-home-"));
  const list: Record<string, unknown>[] = [{ model: "fake-anthropic", displayName: "Fake Anthropic", provider: "anthropic", baseUrl: url, apiKey: "test-key-not-real" }];
  for (let i = 0; i < models; i++) {
    list.push({
      model: `extra-model-${i}`, displayName: `Extra Model ${i}`, provider: i % 2 ? "openai" : "anthropic", baseUrl: url, apiKey: "test-key-not-real",
      ...(i % 3 === 0 ? { maxOutputTokens: 8000, maxContextLimit: 200000 } : {}),
    });
  }
  writeFileSync(join(home, "settings.json"), JSON.stringify({ customModels: list }, null, 2));
  return { home, modelId: "custom:Fake-Anthropic-0" };
}

export async function runStartupCase(c: StartupCase, opts: { serverCount?: number; turns?: number } = {}): Promise<StartupResult> {
  const servers = c.tools === 0 ? 0 : opts.serverCount ?? 5;
  const turns = opts.turns ?? 4;
  const arrivals: number[] = [];
  let firstBody = 0;
  const server = await startFakeAnthropic(Array.from({ length: turns }, () => (body: any) => {
    arrivals.push(performance.now());
    if (!firstBody) firstBody = JSON.stringify(body ?? {}).length;
    return { text: "ok" };
  }));
  const { home, modelId } = makeHomeWithModels(server.url, c.models);
  const repo = makeRepo();
  const prevHome = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = home;
  const { RpcClient } = await import("../src/sdk/client.ts");
  const { inProcessTransport } = await import("../src/sdk/in-process.ts");
  const client = new RpcClient(inProcessTransport({ canPrompt: false }));
  try {
    let connectedAt = 0;
    let idle: (() => void) | undefined;
    client.onNotification = (_m, p) => {
      const n = p.notification;
      if (n?.type === "mcp_status_changed" && n.summary && n.summary.connecting === 0 && n.summary.connected + n.summary.failed >= servers && !connectedAt) connectedAt = performance.now();
      if (n?.type === "agent_working_state_changed" && n.newState === "idle") idle?.();
    };
    const per = Math.ceil(c.tools / Math.max(1, servers));
    const mcpServers = Array.from({ length: servers }, (_, i) => ({
      type: "stdio", name: `srv${i}`, command: process.execPath, args: [MANY],
      env: [{ name: "FAKE_MCP_NAME", value: `srv${i}` }, { name: "FAKE_MCP_TOOLS", value: String(per) }],
    }));
    const t0 = performance.now();
    await client.request("initialize_session", { machineId: "default", cwd: repo, modelId, autonomyLevel: "high", ...(servers ? { mcpServers } : {}) });
    const readyMs = performance.now() - t0;
    if (servers) { const dl = Date.now() + 60_000; while (!connectedAt && Date.now() < dl) await Bun.sleep(2); }
    const connectedMs = servers ? connectedAt - t0 : 0;
    const lt = performance.now();
    await client.request("list_tools", {});
    const listToolsMs = performance.now() - lt;
    const times: number[] = [];
    for (let i = 0; i < turns; i++) {
      const finished = new Promise<void>((r) => (idle = r));
      const s = performance.now();
      await client.request("add_user_message", { text: `turn ${i}` });
      await finished;
      times.push(arrivals[i]! - s);
    }
    return { ...c, servers, readyMs: round(readyMs), connectedMs: round(connectedMs), firstReqMs: round(times[0]!), turnMs: round(median(times.slice(1))), reqKB: round(firstBody / 1024), listToolsMs: round(listToolsMs) };
  } finally {
    await client.request("close_session", { reason: "other" }).catch(() => {});
    await client.close().catch(() => {});
    if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    server.stop();
  }
}

if (import.meta.main) {
  const quick = process.argv.includes("--quick");
  const toolsAxis = quick ? [0, 500] : [0, 100, 500];
  const modelsAxis = quick ? [0, 200] : [0, 50, 200];
  const rows: StartupResult[] = [];
  for (const tools of toolsAxis) for (const models of modelsAxis) rows.push(await runStartupCase({ tools, models }));
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log("| tools | models | servers | ready ms | all connected ms | first request ms | later turn ms | first request KB |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of rows) console.log(`| ${r.tools} | ${r.models} | ${r.servers} | ${r.readyMs} | ${r.connectedMs} | ${r.firstReqMs} | ${r.turnMs} | ${r.reqKB} | ${r.listToolsMs} |`);
  }
  process.exit(0);
}
