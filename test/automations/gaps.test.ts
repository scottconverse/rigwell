// Gap-fix tests for automations: natural-language schedules, auto-pause, host_slept, mcp_unavailable, agent tools,
// cron.state_changed, persisted project registry, userMessageSource. Fake clock, fake model server, temp dirs.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { naturalToCron, normalizeSchedule, parseSchedule, ScheduleError } from "../../src/automations/schedule.ts";
import { AutomationManager } from "../../src/automations/manager.ts";
import type { HeadlessResult, HeadlessRunner } from "../../src/automations/runner.ts";
import { automationsRoot, projectAutomationsRoot } from "../../src/automations/store.ts";
import { createAutomationService, automationTools } from "../../src/automations/index.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { decide } from "../../src/permissions/gate.ts";
import { findSession } from "../../src/storage/transcript.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { lastToolResult, makeHome } from "../e2e/helpers.ts";
import { FakeClock, servers, setup } from "./helpers.ts";

afterAll(() => servers.forEach((s) => s.stop()));

const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "rigwell-auto-home-"));
  process.env.RIGWELL_HOME = home;
  return home;
};
const bad: HeadlessResult = { ok: false, failureReason: "agent_error", errorMessage: "boom", text: "", sessionId: "s" };
const good: HeadlessResult = { ok: true, text: "fine", sessionId: "s" };

describe("natural-language schedules", () => {
  test("common phrases become cron", () => {
    const cases: Record<string, string> = {
      "every weekday at 9am": "0 9 * * 1-5",
      "Every weekday": "0 9 * * 1-5",
      "daily at 18:30": "30 18 * * *",
      "every day at 6:30pm": "30 18 * * *",
      "every monday": "0 9 * * 1",
      "every monday and friday at 8:15pm": "15 20 * * 1,5",
      "every weekend at 10am": "0 10 * * 0,6",
      "weekdays at noon": "0 12 * * 1-5",
      "at 7pm every weekday": "0 19 * * 1-5",
      "monthly on the 15th at 8am": "0 8 15 * *",
      "every hour": "0 * * * *",
      "every day at 12am": "0 0 * * *",
    };
    for (const [text, cron] of Object.entries(cases)) expect([text, naturalToCron(text)]).toEqual([text, cron]);
  });
  test("intervals, presets and cron keep working; nothing else is accepted", () => {
    expect(parseSchedule("every 2 hours").kind).toBe("interval");
    expect(parseSchedule("0 9 * * mon-fri").kind).toBe("cron");
    expect(normalizeSchedule("daily")).toBe("daily");
    expect(normalizeSchedule("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    for (const text of ["bogus", "every funday", "sometime next week", "every weekday at 25:00", "every day at 9:75"]) {
      expect(() => parseSchedule(text)).toThrow(ScheduleError);
    }
    expect(() => parseSchedule("sometime next week")).toThrow(/Cannot understand schedule.*every weekday at 9am/);
  });
  test("the cron is stored at save time, for create and edit", async () => {
    const { mgr, work } = await setup([]);
    const a = mgr.create({ name: "NL", schedule: "every weekday at 9am", timezone: "UTC", workingDirectory: work }, "x");
    expect(a.fm.schedule).toBe("0 9 * * 1-5");
    expect(readFileSync(join(a.dir, "HEARTBEAT.md"), "utf8")).toContain('schedule: "0 9 * * 1-5"');
    expect(mgr.update(a.id, { schedule: "daily at 18:30" }).fm.schedule).toBe("30 18 * * *");
    expect(() => mgr.create({ name: "Bad", schedule: "whenever" }, "x")).toThrow(/Cannot understand schedule/);
  });
});

describe("auto-pause", () => {
  test("repeated failures pause it with a reason; success resets; resume clears", async () => {
    fakeHome();
    const clock = new FakeClock(Date.parse("2026-03-01T00:00:00Z"));
    let next: HeadlessResult = bad;
    const paused: string[] = [];
    const mgr = new AutomationManager({
      runner: async () => next, clock, limits: { maxConsecutiveFailures: 2, retryDelayMs: 1000 },
      onAutoPaused: (a, r) => paused.push(`${a.fm.name}:${r}`),
    });
    const a = mgr.create({ name: "Flaky", schedule: "0 3 * * *", timezone: "UTC" }, "go");
    const fail = async () => {
      mgr.run(a.id);
      await mgr.idle();
      clock.advance(2000);
      await mgr.tick(); // the retry
      await mgr.idle();
    };
    await fail();
    expect(mgr.find(a.id).state).toMatchObject({ health: "degraded", consecutiveFailures: 1 });
    next = good;
    mgr.run(a.id); await mgr.idle();
    expect(mgr.find(a.id).state.consecutiveFailures).toBeUndefined();
    next = bad;
    await fail();
    await fail();
    const p = mgr.find(a.id);
    expect(p.fm.paused).toBe(true);
    expect(p.state).toMatchObject({ pausedReason: "consecutive_failures", consecutiveFailures: 2 });
    expect(paused).toEqual(["Flaky:consecutive_failures"]);
    expect(mgr.nextRunAt(p)).toBeUndefined();

    const resumed = mgr.update(a.id, { paused: false });
    expect(resumed.fm.paused).toBe(false);
    expect(resumed.state.pausedReason).toBeUndefined();
    expect(resumed.state.consecutiveFailures).toBeUndefined();
  });

  test("10 days of missed runs pause instead of a catch-up run", async () => {
    fakeHome();
    const clock = new FakeClock(Date.parse("2026-03-01T00:00:00Z"));
    let runs = 0;
    const mgr = new AutomationManager({ runner: async () => { runs++; return good; }, clock, limits: { sleepGapMs: 1e12 } });
    const a = mgr.create({ name: "Daily", schedule: "0 3 * * *", timezone: "UTC" }, "go");
    clock.advance(9 * 86400_000); // 9 days: still a normal catch-up (checked below with a second automation)
    clock.advance(2 * 86400_000); // 11 days since the first missed slot
    await mgr.tick();
    await mgr.idle();
    expect(runs).toBe(0);
    expect(mgr.find(a.id).state.pausedReason).toBe("missed_runs");
    expect(mgr.find(a.id).fm.paused).toBe(true);

    // After a resume the missed-run clock starts again: no immediate pause, next slot is in the future.
    mgr.update(a.id, { paused: false });
    await mgr.tick();
    expect(mgr.find(a.id).fm.paused).toBe(false);
    clock.advance(86400_000);
    await mgr.tick(); await mgr.idle();
    expect(runs).toBe(1);
  });

  test("under 10 days is still one catch-up run", async () => {
    fakeHome();
    const clock = new FakeClock(Date.parse("2026-03-01T00:00:00Z"));
    let runs = 0;
    const mgr = new AutomationManager({ runner: async () => { runs++; return good; }, clock });
    mgr.create({ name: "Daily", schedule: "0 3 * * *", timezone: "UTC" }, "go");
    clock.advance(5 * 86400_000);
    await mgr.tick(); await mgr.idle();
    expect(runs).toBe(1);
  });
});

describe("host_slept", () => {
  test("a failure that overlaps a detected sleep is host_slept and does not count against the automation", async () => {
    fakeHome();
    const clock = new FakeClock(Date.parse("2026-03-01T00:00:00Z"));
    let release!: (r: HeadlessResult) => void;
    const runner: HeadlessRunner = () => new Promise((r) => (release = r));
    const mgr = new AutomationManager({ runner, clock, limits: { maxConsecutiveFailures: 1, retryDelayMs: 1000 } });
    const a = mgr.create({ name: "Sleepy", schedule: "0 3 * * *", timezone: "UTC" }, "go");
    await mgr.tick(); // establishes the tick baseline
    const { done } = mgr.run(a.id);
    clock.advance(10 * 60_000); // the machine slept for ten minutes
    await mgr.tick(); // sees the gap
    release(bad);
    const rec = await done;
    expect(rec.status).toBe("failure");
    expect(rec.failureReason).toBe("host_slept");
    // not the automation's fault: not counted, never auto-paused (the retry is still scheduled)
    expect(mgr.find(a.id).state.retry).toBeDefined();
    expect(mgr.find(a.id).state.consecutiveFailures).toBeUndefined();
    expect(mgr.find(a.id).fm.paused).toBeFalsy();
  });
});

describe("mcp_unavailable and userMessageSource", () => {
  test("a server that fails to load flags the run; the run still completes; the prompt is marked as automation", async () => {
    const { mgr, home, work } = await setup([{ text: "all done" }]);
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { broken: { command: "/definitely/not/a/real/binary" } } }));
    const a = mgr.create({ name: "WithMcp", schedule: "daily", workingDirectory: work }, "do it");
    const { done } = mgr.run(a.id);
    const rec = await done;
    expect(rec.status).toBe("success");
    expect(rec.mcpUnavailable).toBe(true);
    const files = findSession(rec.sessionId!);
    const transcript = readFileSync(files!.transcriptPath, "utf8");
    expect(transcript).toContain('"userMessageSource":"automation"');
  }, 30000);

  test("no failing server: no flag", async () => {
    const { mgr, work } = await setup([{ text: "ok" }]);
    const a = mgr.create({ name: "Clean", schedule: "daily", workingDirectory: work }, "do it");
    const rec = await mgr.run(a.id).done;
    expect(rec.status).toBe("success");
    expect(rec.mcpUnavailable).toBeUndefined();
  }, 30000);
});

describe("project registry", () => {
  test("known project folders survive a restart", async () => {
    fakeHome();
    const project = mkdtempSync(join(tmpdir(), "rigwell-auto-proj-"));
    const first = new AutomationManager({ runner: async () => good });
    first.create({ name: "Proj one", schedule: "daily" }, "x", project);
    mkdirSync(join(projectAutomationsRoot(project), "..", "..", "keep"), { recursive: true });
    const second = new AutomationManager({ runner: async () => good }); // a new process: no projectDirs given
    expect(second.list().map((x) => x.fm.name)).toEqual(["Proj one"]);
    expect([...second.projectDirs]).toEqual([path.resolve(project)]);
    expect(automationsRoot()).not.toContain("rigwell-auto-proj");
  });
});

describe("agent tools", () => {
  const ctx = (cwd: string, sessionId = "11111111-1111-4111-8111-111111111111") => ({ cwd, sessionId, readFiles: new Map(), signal: new AbortController().signal });
  const find = (tools: ReturnType<typeof automationTools>, n: string) => tools.find((t) => t.name === n)!;

  test("names, schemas and permission decisions", () => {
    const svc = createAutomationService({});
    const tools = automationTools(svc);
    expect(tools.map((t) => t.name)).toEqual(["CreateAutomation", "ListAutomations", "ReadAutomation", "EditAutomation", "DeleteAutomation", "RunAutomation", "Loop"]);
    for (const t of tools) { expect(t.description.length).toBeGreaterThan(40); expect((t.inputSchema as any).type).toBe("object"); }
    const pctx = { autonomy: "high", interactionMode: "auto", skipPermissions: false, lists: { allow: [], deny: [], block: [] }, cwd: "/x" } as any;
    expect(decide("ListAutomations", {}, pctx).decision).toBe("allow");
    expect(decide("ReadAutomation", { id: "x" }, pctx).decision).toBe("allow");
    for (const n of ["CreateAutomation", "EditAutomation", "DeleteAutomation", "RunAutomation"]) expect(decide(n, {}, pctx).decision).toBe("ask");
    expect(decide("Loop", { action: "start" }, pctx).decision).toBe("ask");
    expect(decide("Loop", { action: "list" }, pctx).decision).toBe("allow");
  });

  test("create, list, read, edit, run, delete", async () => {
    const { work } = await setup([{ text: "ran" }]);
    const clock = new FakeClock(Date.parse("2026-03-01T00:00:00Z"));
    const svc = createAutomationService({ clock, retryBaseDelayMs: 1 });
    const tools = automationTools(svc);
    const c = ctx(work);
    const made = await find(tools, "CreateAutomation").run({ name: "Nightly", schedule: "every weekday at 9am", instructions: "Say hi.", workingDirectory: work, timezone: "UTC" }, c);
    expect(made.isError).toBeUndefined();
    const view = JSON.parse(made.content);
    expect(view.schedule).toBe("0 9 * * 1-5");
    expect(view.nextRunAt).toBe(Date.parse("2026-03-02T09:00:00Z"));

    const bad = await find(tools, "CreateAutomation").run({ name: "Nope", schedule: "when i feel like it", instructions: "x" }, c);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Cannot understand schedule");

    const listed = JSON.parse((await find(tools, "ListAutomations").run({}, c)).content);
    expect(listed.automations).toHaveLength(1);
    expect(listed.automations[0]).toMatchObject({ name: "Nightly", status: "active" });

    const read = JSON.parse((await find(tools, "ReadAutomation").run({ id: view.id }, c)).content);
    expect(read.instructions.trim()).toBe("Say hi.");
    expect(read.recentRuns).toEqual([]);

    const edited = JSON.parse((await find(tools, "EditAutomation").run({ id: view.id, paused: true, instructions: "Say bye." }, c)).content);
    expect(edited.status).toBe("paused");
    expect(edited.instructions.trim()).toBe("Say bye.");
    expect((await find(tools, "EditAutomation").run({ id: "missing", paused: true }, c)).isError).toBe(true);

    const ran = JSON.parse((await find(tools, "RunAutomation").run({ id: view.id }, c)).content);
    expect(ran.runId).toBeTruthy();
    await svc.manager.idle();
    expect(JSON.parse((await find(tools, "ReadAutomation").run({ id: view.id }, c)).content).recentRuns[0].status).toBe("success");

    expect((await find(tools, "DeleteAutomation").run({ id: view.id }, c)).content).toContain("Deleted");
    expect(JSON.parse((await find(tools, "ListAutomations").run({}, c)).content).automations).toEqual([]);
  }, 30000);

  test("scope project writes under the project and registers it", async () => {
    fakeHome();
    const project = mkdtempSync(join(tmpdir(), "rigwell-auto-proj-"));
    const svc = createAutomationService({});
    const tools = automationTools(svc);
    const r = await find(tools, "CreateAutomation").run({ name: "In project", schedule: "daily", instructions: "x", scope: "project" }, ctx(project));
    expect(JSON.parse(r.content).folder).toBe("in-project");
    expect(svc.manager.list()[0]!.source).toBe("project");
    expect(svc.manager.list()[0]!.dir.startsWith(project)).toBe(true);
    expect(new AutomationManager({ runner: async () => good }).list()).toHaveLength(1); // found again after a "restart"
  });

  test("Loop starts, lists and stops loops for the calling session, and emits cron.state_changed", async () => {
    fakeHome();
    const seen: string[] = [];
    const clock = new FakeClock(Date.parse("2026-03-01T10:07:00Z"));
    const svc = createAutomationService({ clock, onCronChanged: (c) => seen.push(`${c.status}:${c.id}`) });
    const tools = automationTools(svc);
    const loop = find(tools, "Loop");
    const c = ctx(tmpdir());
    const started = JSON.parse((await loop.run({ action: "start", interval: "30m", prompt: "check the build" }, c)).content);
    expect(started.expression).toMatch(/^\d+-59\/30 \* \* \* \*$/);
    expect((await loop.run({ action: "start", interval: "7m", prompt: "x" }, c)).isError).toBe(true);
    expect((await loop.run({ action: "start", interval: "1h" }, c)).content).toContain("loop.md");
    writeFileSync(join(process.env.RIGWELL_HOME!, "loop.md"), "default loop prompt\n");
    const second = JSON.parse((await loop.run({ action: "start", interval: "2h" }, c)).content);
    expect(svc.crons.get(second.id).prompt).toBe("default loop prompt");
    const other = ctx(tmpdir(), "22222222-2222-4222-8222-222222222222");
    expect(JSON.parse((await loop.run({ action: "list" }, other)).content).loops).toEqual([]);
    expect(JSON.parse((await loop.run({ action: "list" }, c)).content).loops).toHaveLength(2);
    expect((await loop.run({ action: "stop", id: "all" }, c)).content).toContain("Stopped 2");
    expect(JSON.parse((await loop.run({ action: "list" }, c)).content).loops).toEqual([]);
    expect(seen.filter((s) => s.startsWith("active")).length).toBe(2);
    expect(seen.filter((s) => s.startsWith("cancelled")).length).toBe(2);
  });

  test("a session on the fake model calls ListAutomations through extraTools; mutating tools are denied when nobody can approve", async () => {
    const model = await startFakeAnthropic([
      { toolCalls: [{ id: "tu_1", name: "ListAutomations", input: {} }] },
      { toolCalls: [{ id: "tu_2", name: "CreateAutomation", input: { name: "Sneaky", schedule: "daily", instructions: "x" } }] },
      { text: "done" },
    ]);
    servers.push(model);
    const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "Fake Anthropic" }]);
    process.env.RIGWELL_HOME = home;
    const svc = createAutomationService({});
    svc.manager.create({ name: "Existing", schedule: "daily" }, "keep me");
    const out: any[] = [];
    const conn = createConnection((l) => { for (const x of l.split("\n")) if (x.trim()) out.push(JSON.parse(x)); }, { canPrompt: false, retryBaseDelayMs: 1, extraTools: () => automationTools(svc) });
    let n = 0;
    const call = async (method: string, params: Record<string, unknown>) => {
      const id = `t${++n}`;
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
      for (let i = 0; i < 500 && !out.some((m) => m.id === id); i++) await Bun.sleep(5);
      return out.find((m) => m.id === id);
    };
    const cwd = mkdtempSync(join(tmpdir(), "rigwell-auto-cwd-"));
    const init = await call("initialize_session", { cwd, modelId: "custom:Fake-Anthropic-0" });
    expect(init.error).toBeUndefined();
    await call("add_user_message", { text: "what automations exist?" });
    const turnDone = () => out.some((m) => m.params?.notification?.type === "agent_turn_completed");
    for (let i = 0; i < 1000 && !turnDone(); i++) await Bun.sleep(10);
    // Request 1 listed the automations; request 2 asked to create one, nobody could approve, so the turn ended.
    expect(model.requests.length).toBe(2);
    expect(lastToolResult(model.requests[1])).toContain("Existing");
    expect(JSON.stringify(out)).toContain("CreateAutomation");
    expect(svc.manager.list().map((a) => a.fm.name)).toEqual(["Existing"]);
    await call("close_session", {});
    await conn.shutdown();
  }, 30000);
});

describe("cron.state_changed over the daemon", () => {
  test("create_cron broadcasts rigwell.cron.state_changed", async () => {
    fakeHome();
    const { startDaemon } = await import("../../src/daemon/daemon.ts");
    const sock = join(mkdtempSync(join(tmpdir(), "rigwell-auto-sock-")), "d.sock");
    const d = await startDaemon({ socketPath: sock, ws: false, sidepane: false });
    const lines: string[] = [];
    const client = await Bun.connect({ unix: sock, socket: { data(_s, b) { lines.push(...Buffer.from(b).toString().split("\n").filter(Boolean)); } } });
    client.write(JSON.stringify({ jsonrpc: "2.0", type: "request", id: "1", method: "rigwell.create_cron", params: { sessionId: "33333333-3333-4333-8333-333333333333", prompt: "tick", interval: "30m" } }) + "\n");
    for (let i = 0; i < 300 && !lines.some((l) => l.includes("cron.state_changed")); i++) await Bun.sleep(10);
    const note = lines.map((l) => JSON.parse(l)).find((m) => m.method === "rigwell.cron.state_changed");
    expect(note?.params.cron).toMatchObject({ status: "active", source: "cron_tool" });
    client.end();
    d.stop();
  }, 20000);
});
