// Deferred tools (spec §6.2), the cache monitor (§6.3) and warmup_cache, in process with a scripted model.
import { describe, expect, test } from "bun:test";
import { DeferredRegistry, signatureOf } from "../../src/agent/deferred.ts";
import { CacheMonitor } from "../../src/agent/cache-monitor.ts";
import type { Tool } from "../../src/core/types.ts";
import { call, makeStubSession, text } from "./helpers.ts";

const weather: Tool = {
  name: "weather_lookup", description: "Looks up the weather for a city.\nSecond line.", category: "read",
  inputSchema: { type: "object", properties: { city: { type: "string" }, days: { type: "integer" } }, required: ["city"] },
  run: async (i) => ({ content: `sunny in ${i.city}` }),
};
const mail: Tool = {
  name: "mail__send", description: "Sends a mail.", category: "execute",
  inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  run: async () => ({ content: "sent" }),
};

const json = (x: unknown) => JSON.stringify(x);
const toolsOf = (r: any) => json(r.tools);

describe("DeferredRegistry", () => {
  test("signature, search, select, dedupe of notices", () => {
    expect(signatureOf(weather)).toBe("weather_lookup({ city: string, days?: integer })");
    const r = new DeferredRegistry();
    r.register(weather); r.register(mail);
    expect(r.search("weather").loaded.map((e) => e.name)).toEqual(["weather_lookup"]);
    expect(r.takeNotices().length).toBe(1);
    expect(r.search("select:weather_lookup,nope")).toEqual({ loaded: [expect.objectContaining({ name: "weather_lookup" })], more: 0, unknown: ["nope"] });
    expect(r.takeNotices().length).toBe(0); // already loaded: no second announcement
    expect(r.search("e", 1).more).toBe(1);
  });

  test("announcement lists names once, then only deltas", () => {
    const r = new DeferredRegistry();
    expect(r.announcement()).toBeNull();
    r.register(weather);
    expect(r.announcement()).toContain("weather_lookup");
    expect(r.announcement()).toBeNull();
    r.register(mail);
    r.unregister("weather_lookup");
    const d = r.announcement()!;
    expect(d).toContain("now available: mail__send");
    expect(d).toContain("no longer available: weather_lookup");
  });
});

describe("deferred tools in a session", () => {
  test("direct_only: load_tools then call_tool; tools array and system stay byte-identical; history only grows", async () => {
    const s = makeStubSession((req, n) => {
      if (n === 0) return call("load_tools", { names: ["weather_lookup"] }, "t1");
      if (n === 1) return call("call_tool", { name: "weather_lookup", args: { city: "Oslo" } }, "t2");
      return text("It is sunny in Oslo.");
    }, { toolExecutionModeOverride: "direct_only" });
    s.session.registerDeferredTool(weather);
    s.session.addUserMessage("weather?");
    await s.session.settled();

    expect(s.requests.length).toBe(3);
    const names = s.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain("load_tools");
    expect(names).toContain("call_tool");
    expect(names).not.toContain("weather_lookup");
    for (const r of s.requests) {
      expect(toolsOf(r)).toBe(toolsOf(s.requests[0]));
      expect(json(r.system)).toBe(json(s.requests[0]!.system));
    }
    // the first request announces the name; later ones extend the earlier history
    const flat = (r: any) => r.messages.flatMap((m: any) => m.content.map((b: any) => (b.text ?? b.content ?? "")));
    expect(flat(s.requests[0]).some((t: string) => t.includes("Deferred tools") && t.includes("weather_lookup"))).toBe(true);
    const last = s.requests[2]!.messages;
    expect(JSON.stringify(last)).toContain("sunny in Oslo");
    expect(JSON.stringify(last)).toContain("Tools loaded");
    expect(JSON.stringify(last)).toContain("weather_lookup({ city: string, days?: integer })");
    const st = s.session.builder.monitor.stats();
    expect(st.requests).toBe(3);
    expect(st.strictAppend).toBe(2);
    expect(st.divergences).toEqual([]);
    expect(s.session.deferred.loadedNames()).toEqual(["weather_lookup"]);
  });

  test("call_tool on a tool that is not loaded returns an error that says to load it", async () => {
    const s = makeStubSession((req, n) => (n === 0 ? call("call_tool", { name: "weather_lookup", args: { city: "x" } }, "t1") : text("ok")));
    s.session.registerDeferredTool(weather);
    s.session.addUserMessage("go");
    await s.session.settled();
    expect(JSON.stringify(s.requests[1]!.messages.at(-1))).toContain("is not loaded");
  });

  test("a tool that is not read-only asks for permission", async () => {
    const s = makeStubSession((req, n) => {
      if (n === 0) return call("load_tools", { names: ["mail__send"] }, "t1");
      if (n === 1) return call("call_tool", { name: "mail__send", args: { to: "a@b" } }, "t2");
      return text("done");
    });
    s.session.registerDeferredTool(mail);
    s.session.addUserMessage("mail");
    await s.session.settled();
    // autoRejectPermissionRequests is on in the stub: the call is refused, not run
    expect(JSON.stringify(s.requests[2]!.messages.at(-1))).toContain("rejected this tool call");
  });

  test("script_only: tools.ToolSearch and the loaded tool in the same Script; the tools array is Script, script_job and the job tools", async () => {
    const code = "const r = await tools.ToolSearch({ query: 'weather' });\nprint(r.loaded.map(x => x.name).join());\nprint(JSON.stringify(await tools.weather_lookup({ city: 'Rome' })));";
    const s = makeStubSession((req, n) => (n === 0 ? call("Script", { script: code }, "t1") : text("done")), { toolExecutionModeOverride: "script_only" });
    s.session.registerDeferredTool(weather);
    s.session.addUserMessage("weather in Rome");
    await s.session.settled();
    expect(s.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["Script", "TaskOutput", "TaskStop", "script_job"]);
    const result = JSON.stringify(s.requests[1]!.messages.at(-1));
    expect(result).toContain("weather_lookup");
    expect(result).toContain("sunny in Rome");
    expect(result).toContain("Tools loaded"); // the notice rides in the same message
    expect(toolsOf(s.requests[1])).toBe(toolsOf(s.requests[0]));
  });

  test("Script description gains no per-session variation when tools load (stable bytes)", async () => {
    const a = makeStubSession(() => text("x"), { toolExecutionModeOverride: "script_only" });
    const b = makeStubSession(() => text("x"), { toolExecutionModeOverride: "script_only" });
    b.session.registerDeferredTool(weather);
    a.session.addUserMessage("hi"); b.session.addUserMessage("hi");
    await a.session.settled(); await b.session.settled();
    expect(toolsOf(a.requests[0])).toBe(toolsOf(b.requests[0]));
  });

  test("loaded set is restored from saved state and survives a tool that registers later", async () => {
    const s = makeStubSession((req, n) => (n === 0 ? call("call_tool", { name: "weather_lookup", args: { city: "Bern" } }, "t1") : text("ok")), {
      deferred: { loaded: ["weather_lookup"], announced: ["weather_lookup"] },
    });
    s.session.registerDeferredTool(weather);
    s.session.addUserMessage("go");
    await s.session.settled();
    expect(JSON.stringify(s.requests[1]!.messages.at(-1))).toContain("sunny in Bern");
    // announced already: no first-announcement reminder
    expect(JSON.stringify(s.requests[0]!.messages)).not.toContain("Deferred tools (names only");
  });

  test("tools appearing and disappearing mid-session arrive as appended delta reminders", async () => {
    const s = makeStubSession((req, n) => (n === 0 ? call("Read", { path: "a.txt" }, "t1") : text("ok")));
    s.session.addUserMessage("one");
    await s.session.settled();
    s.session.registerDeferredTool(mail);
    s.session.addUserMessage("two");
    await s.session.settled();
    const last = JSON.stringify(s.requests.at(-1)!.messages);
    expect(last).toContain("Deferred tools (names only");
    expect(last).toContain("mail__send");
    expect(s.session.builder.monitor.stats().divergences).toEqual([]);
  });

  test("get_context_stats data: breakdown has mcpTools after the announcement, cache numbers are present", async () => {
    const s = makeStubSession(() => text("x"));
    s.session.registerDeferredTool(weather);
    s.session.addUserMessage("hi");
    await s.session.settled();
    const st = s.session.contextStats(200_000) as any;
    expect(st.breakdown.mcpTools).toBeGreaterThan(0);
    expect(st.breakdown.tools).toBeGreaterThan(0);
    expect(st.accuracy).toBe("exact");
    expect(st.cache.requests).toBe(1);
  });

  test("warmup_cache sends the current prefix with a tiny output limit and does not touch the history", async () => {
    const s = makeStubSession(() => text("done"));
    s.session.addUserMessage("hi");
    await s.session.settled();
    const before = s.session.messages.length;
    await s.session.warmupCache();
    expect(s.requests.length).toBe(2);
    const w = s.requests[1]!;
    expect(w.maxOutputTokens).toBe(16);
    expect(w.messages.at(-1)!.role).toBe("user");
    expect(toolsOf(w)).toBe(toolsOf(s.requests[0]));
    expect(json(w.system)).toBe(json(s.requests[0]!.system));
    // the real history is a prefix of the warm-up request
    expect(JSON.stringify(w.messages.slice(0, before).map((m) => m.id))).toBe(JSON.stringify(s.session.messages.map((m) => m.id)));
    expect(s.session.messages.length).toBe(before);
    expect(s.session.builder.monitor.stats().requests).toBe(1);
  });
});

describe("CacheMonitor", () => {
  const mk = (sys: string[], tools: string[], msgs: [string, string][]) => ({
    system: sys, tools: tools.map((n) => ({ name: n, description: n, inputSchema: {} })),
    messages: msgs.map(([id, t]) => ({ id, role: "user" as const, content: [{ type: "text" as const, text: t }] })),
  });

  test("names the first divergent block and a cause", () => {
    const logs: string[] = [];
    const m = new CacheMonitor((l) => logs.push(l));
    m.observe(mk(["s"], ["a"], [["1", "x"]]));
    expect(m.observe(mk(["s"], ["a"], [["1", "x"], ["2", "y"]]))).toBeNull();
    const d1 = m.observe(mk(["s"], ["a"], [["1", "x!"], ["2", "y"], ["3", "z"]]))!;
    expect(d1.block).toBe("messages[0].content[0]");
    expect(d1.cause).toContain("earlier message edited");
    const d2 = m.observe(mk(["s"], ["a", "b"], [["1", "x!"], ["2", "y"], ["3", "z"]]))!;
    expect(d2.block).toBe("tools");
    m.expectBreak("model changed");
    const d3 = m.observe(mk(["S2"], ["a", "b"], [["1", "x!"], ["2", "y"], ["3", "z"]]))!;
    expect(d3.block).toBe("system[0]");
    expect(d3.cause).toBe("model changed");
    const d4 = m.observe(mk(["S2"], ["a", "b"], [["9", "summary"]]))!;
    expect(d4.block).toBe("messages");
    expect(logs.length).toBe(4);
    const st = m.stats();
    expect(st.comparable).toBe(5);
    expect(st.strictAppend).toBe(1);
  });

  test("token-weighted and median cache-read share", () => {
    const m = new CacheMonitor();
    m.recordUsage({ inputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 900 });
    m.recordUsage({ inputTokens: 10, cacheReadTokens: 990, cacheCreationTokens: 0 });
    m.recordUsage({ inputTokens: 10, cacheReadTokens: 1990, cacheCreationTokens: 0 });
    const s = m.stats();
    expect(s.cacheReadShareTokenWeighted).toBeCloseTo(2980 / 4000, 5);
    expect(s.cacheReadShareMedian).toBeCloseTo(0.99, 2);
  });
});
