// Phase 3 done-when: at least 95% cache-read (token weighted) on a 50-turn session with a tool loaded
// mid-session, and every request strictly extends the previous one. The fake servers simulate prefix caching.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../../src/core/types.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import { PrefixCache, type FakeServer, type FakeTurn } from "../fakes/types.ts";
import { makeRepo } from "./helpers.ts";
import { inproc } from "./inproc.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const PROVIDERS = [
  { provider: "anthropic" as const, start: startFakeAnthropic, name: "Fake Anthropic", modelId: "custom:Fake-Anthropic-0" },
  { provider: "openai" as const, start: startFakeOpenAI, name: "Fake OpenAI", modelId: "custom:Fake-OpenAI-0" },
];

const weather: Tool = {
  name: "weather_lookup", description: "Looks up the weather for a city.", category: "read",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  run: async (i) => ({ content: `sunny in ${i.city}` }),
};
const mail: Tool = {
  name: "mail__send", description: "Sends a mail.", category: "read",
  inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  run: async () => ({ content: "sent" }),
};

/** Strict extension of one request body by the next, per provider wire shape (cache markers ignored). */
function extendsPrev(provider: "anthropic" | "openai", a: any, b: any): string | null {
  const strip = (x: any): any => JSON.parse(JSON.stringify(x, (k, v) => (k === "cache_control" ? undefined : v)));
  if (JSON.stringify(a.tools) !== JSON.stringify(b.tools)) return "tools changed";
  const sysA = provider === "anthropic" ? JSON.stringify(strip(a.system)) : a.instructions;
  const sysB = provider === "anthropic" ? JSON.stringify(strip(b.system)) : b.instructions;
  if (sysA !== sysB) return "system changed";
  const ma = strip(provider === "anthropic" ? a.messages : a.input);
  const mb = strip(provider === "anthropic" ? b.messages : b.input);
  if (mb.length < ma.length) return "history shortened";
  for (let i = 0; i < ma.length; i++) if (JSON.stringify(ma[i]) !== JSON.stringify(mb[i])) return `message ${i} changed`;
  return null;
}

const TURNS = 50;

describe.each(PROVIDERS)("prompt cache: $provider", (p) => {
  test(`${TURNS} turns, a tool loaded at turn 25: >= 95% cache read, every request strictly append-only`, async () => {
    const turnOf = (idx: number) => Math.floor(idx / 2) + 1;
    const script: FakeTurn[] = Array.from({ length: TURNS * 2 + 10 }, () => (_body: any, idx: number) => {
      const t = turnOf(idx);
      if (idx % 2 === 1) return { text: `Done with step ${t}.` };
      if (t === 25) return { toolCalls: [{ name: "load_tools", input: { names: ["weather_lookup"] } }] };
      if (t === 26 || t === 31 || t === 44) return { toolCalls: [{ name: "call_tool", input: { name: "weather_lookup", args: { city: `City${t}` } } }] };
      return { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] };
    });
    const server = await p.start(script, { simulateCache: true });
    servers.push(server);
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "rigwell-cache-home-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      customModels: [{ model: `fake-${p.provider}`, displayName: p.name, provider: p.provider, baseUrl: server.url, apiKey: "test-key-not-real" }],
    }));
    const prevHome = process.env.RIGWELL_HOME;
    process.env.RIGWELL_HOME = home;
    try {
      const c = inproc();
      await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: p.modelId, toolExecutionMode: "direct_only", autonomyLevel: "low" });
      const session = c.conn.session!;
      session.registerDeferredTool(weather);
      for (let t = 1; t <= TURNS; t++) {
        if (t === 11) session.registerDeferredTool(mail); // a delta reminder arrives mid-session
        await c.turn(`step ${t}`);
      }
      const stats = await c.call("get_context_stats", {});
      await c.call("close_session", { reason: "other" });

      expect(server.requests.length).toBe(TURNS * 2);
      // independent check of the wire bodies
      for (let i = 1; i < server.requests.length; i++) {
        expect(extendsPrev(p.provider, server.requests[i - 1], server.requests[i])).toBeNull();
      }
      // the tool was really loaded and called
      const wire = JSON.stringify(server.requests.at(-1));
      expect(wire).toContain("sunny in City26");
      expect(wire).toContain("Tools loaded");
      expect(wire).toContain("Deferred tools now available: mail__send");
      const sent = server.requests[0].tools.map((t: any) => t.name);
      expect(sent).toContain("load_tools");
      expect(sent).not.toContain("weather_lookup");

      // the cache monitor and the provider-reported usage agree
      expect(stats.cache.requests).toBe(TURNS * 2);
      expect(stats.cache.strictAppendShare).toBe(1);
      expect(stats.cache.divergences).toEqual([]);
      const total = c.notes().filter((n) => n.type === "session_token_usage_changed").at(-1).tokenUsage;
      const share = total.cacheReadTokens / (total.inputTokens + total.cacheReadTokens + total.cacheCreationTokens);
      console.log(`[cache ${p.provider}] token-weighted cache-read share ${(share * 100).toFixed(2)}%, median ${(stats.cache.cacheReadShareMedian * 100).toFixed(2)}%, strict-append ${stats.cache.strictAppend}/${stats.cache.comparable}`);
      expect(share).toBeGreaterThanOrEqual(0.95);
      expect(stats.cache.cacheReadShareTokenWeighted).toBeCloseTo(share, 6);
      expect(stats.breakdown.mcpTools).toBeGreaterThan(0);
    } finally {
      if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    }
  }, 120_000);
});

describe("prefix cache simulator (negative controls)", () => {
  const big = (n: string) => n.repeat(5000);
  test("explicit: reading stops at the first changed block; a changed tools block loses everything", () => {
    const c = new PrefixCache("explicit");
    c.lookup({ blocks: ["tools", big("a"), big("b")], breakpoints: [3] });
    expect(c.lookup({ blocks: ["tools", big("a"), big("b"), big("c")], breakpoints: [4] }).cacheRead).toBeGreaterThan(2500);
    const lost = c.lookup({ blocks: ["TOOLS2", big("a"), big("b"), big("c"), big("d")], breakpoints: [5] });
    expect(lost.cacheRead).toBe(0);
    expect(lost.cacheCreation).toBeGreaterThan(4000);
  });
  test("automatic: shares the common prefix only", () => {
    const c = new PrefixCache("automatic");
    c.lookup({ blocks: [big("a"), big("b")], breakpoints: [] });
    const r = c.lookup({ blocks: [big("a"), big("x")], breakpoints: [] });
    expect(r.cacheRead).toBe(1250);
    expect(r.input).toBe(1250);
  });
});

describe("loaded tools persist; warmup_cache", () => {
  test("loaded set is saved in the session settings and restored by load_session; warmup_cache reads the cached prefix", async () => {
    const p = PROVIDERS[0]!;
    const server = await p.start([
      { toolCalls: [{ name: "load_tools", input: { names: ["weather_lookup"] } }] },
      { text: "loaded" },
      { text: "warm" },
      () => ({ toolCalls: [{ name: "call_tool", input: { name: "weather_lookup", args: { city: "Oslo" } } }] }),
      { text: "sunny" },
    ], { simulateCache: true });
    servers.push(server);
    const repo = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "rigwell-cache-home-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      customModels: [{ model: "fake-anthropic", displayName: p.name, provider: "anthropic", baseUrl: server.url, apiKey: "test-key-not-real" }],
    }));
    const prevHome = process.env.RIGWELL_HOME;
    process.env.RIGWELL_HOME = home;
    try {
      const a = inproc();
      const init = await a.call("initialize_session", { machineId: "default", cwd: repo, modelId: p.modelId, toolExecutionMode: "direct_only" });
      a.conn.session!.registerDeferredTool(weather);
      await a.turn("load the weather tool");
      expect(await a.call("warmup_cache", {})).toEqual({});
      const warm = server.requests[2];
      expect(warm.max_tokens).toBe(16);
      const usage = a.notes().filter((n) => n.type === "session_token_usage_changed").at(-1);
      expect(usage.tokenUsage.cacheReadTokens).toBeGreaterThan(1000);
      await a.call("close_session", { reason: "other" });

      const b = inproc();
      await b.call("load_session", { sessionId: init.sessionId, cwd: repo });
      expect(b.conn.session!.deferred.loadedNames()).toEqual(["weather_lookup"]);
      b.conn.session!.registerDeferredTool(weather);
      await b.turn("what is the weather in Oslo");
      expect(JSON.stringify(server.requests.at(-1))).toContain("sunny in Oslo");
      // the resumed session sends the same system and tools, and the history extends the saved one
      // (the warm-up request ends with a throwaway user message, so compare the saved history only)
      const hist = (r: any) => JSON.stringify(r.messages.slice(0, 6), (k, v) => (k === "cache_control" ? undefined : v));
      expect(hist(server.requests[3])).toBe(hist(server.requests[2]));
      expect(JSON.stringify(server.requests[3].tools)).toBe(JSON.stringify(server.requests[2].tools));
      await b.call("close_session", { reason: "other" });
    } finally {
      if (prevHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prevHome;
    }
  }, 30_000);
});
