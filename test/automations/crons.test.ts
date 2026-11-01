import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronRunner, CronStore, loopIntervalToCron, type CronHost } from "../../src/automations/crons.ts";
import { nextRun, parseSchedule } from "../../src/automations/schedule.ts";
import { FakeClock } from "./helpers.ts";

function env() {
  process.env.RIGWELL_HOME = mkdtempSync(join(tmpdir(), "rigwell-cron-home-"));
  const clock = new FakeClock(Date.parse("2026-03-01T10:07:20Z"));
  const live = new Set<string>(["s1"]);
  const busy = new Set<string>();
  const injected: [string, string][] = [];
  const host: CronHost = {
    isLive: (id) => live.has(id), isBusy: (id) => busy.has(id),
    inject: (id, p) => { injected.push([id, p]); return true; },
  };
  const store = new CronStore(clock);
  const runner = new CronRunner(store, host, clock);
  return { clock, live, busy, injected, store, runner };
}

describe("loop intervals", () => {
  test("map to exact cron anchored to the creation minute; odd steps are refused", () => {
    const at = new Date(2026, 2, 1, 10, 7, 20);
    expect(loopIntervalToCron("30m", at)).toBe("7-59/30 * * * *");
    expect(loopIntervalToCron("2h", at)).toBe("7 0-23/2 * * *");
    expect(loopIntervalToCron("24h", at)).toBe("7 10 * * *");
    expect(() => loopIntervalToCron("7m", at)).toThrow();
    expect(() => loopIntervalToCron("5h", at)).toThrow();
    const next = nextRun(parseSchedule("7-59/30 * * * *"), Date.parse("2026-03-01T10:08:00Z"), "UTC");
    expect(new Date(next!).toISOString()).toBe("2026-03-01T10:37:00.000Z");
  });
});

describe("session crons", () => {
  test("fires into a live session, counts the fire, and never queues two", () => {
    const e = env();
    const c = e.store.create({ sessionId: "s1", prompt: "check build", expression: "*/5 * * * *", source: "loop_command" });
    expect(c.status).toBe("active");
    e.clock.set("2026-03-01T10:10:00Z");
    e.runner.tick();
    expect(e.injected).toEqual([["s1", "check build"]]);
    expect(e.store.get(c.id).stats.fireCount).toBe(1);

    e.busy.add("s1"); // previous prompt still queued: skip the tick
    e.clock.set("2026-03-01T10:15:00Z");
    e.runner.tick();
    expect(e.injected.length).toBe(1);
    expect(e.store.get(c.id).stats.fireCount).toBe(1);
  });

  test("a session with no live client is held; a fire over 30 s late is skipped with no catch-up", () => {
    const e = env();
    const c = e.store.create({ sessionId: "s1", prompt: "p", expression: "*/5 * * * *" });
    e.live.clear();
    e.clock.set("2026-03-01T10:10:00Z");
    e.runner.tick();
    expect(e.store.get(c.id).status).toBe("held");
    expect(e.injected.length).toBe(0);

    e.live.add("s1");
    e.clock.set("2026-03-01T10:20:45Z"); // 45 s after the 10:20 slot
    e.runner.tick();
    expect(e.injected.length).toBe(0);
    e.clock.set("2026-03-01T10:25:05Z");
    e.runner.tick();
    expect(e.injected.length).toBe(1);
    expect(e.store.get(c.id).status).toBe("active");
  });

  test("one-shot crons expire; delete marks cancelled and stops firing", () => {
    const e = env();
    const once = e.store.create({ sessionId: "s1", prompt: "once", expression: "*/5 * * * *", recurring: false });
    const rep = e.store.create({ sessionId: "s1", prompt: "rep", expression: "*/5 * * * *" });
    e.store.delete(rep.id);
    expect(e.store.get(rep.id).status).toBe("cancelled");
    expect(e.store.list().map((c) => c.id)).toEqual([once.id]);
    e.clock.set("2026-03-01T10:10:02Z");
    e.runner.tick();
    expect(e.injected).toEqual([["s1", "once"]]);
    expect(e.store.get(once.id).status).toBe("expired");
    e.clock.set("2026-03-01T10:15:02Z");
    e.runner.tick();
    expect(e.injected.length).toBe(1);
  });
});
