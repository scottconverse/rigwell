import { expect, test } from "bun:test";
import { badges, localStats, type StatSession } from "../../src/analytics/stats.ts";

const M = 60_000;
const WEEKEND_AT = 1_000;
const isWeekend = (ms: number) => ms >= WEEKEND_AT;
const session = (times: number[], firstAt = times[0] ?? 0): StatSession => ({ times, firstAt });
const many = (count: number, times: number[], firstAt = 0) => Array.from({ length: count }, () => session(times, firstAt));

test("zero sessions earn nothing and never show NaN", () => {
  const stats = localStats([], isWeekend), list = badges(stats);
  expect(stats).toEqual({ sessions: 0, activeMs: 0, longestMs: 0, weekendSessions: 0 });
  expect(list).toHaveLength(4);
  expect(list.every((b) => !b.earned)).toBe(true);
  expect(list.find((b) => b.name === "Weekend Builder")?.progress).toBe("0% of sessions on weekends");
  expect(JSON.stringify(list)).not.toContain("NaN");
});

test("one session measures its own span as active and longest time", () => {
  const stats = localStats([session([0, 10 * M, 20 * M])], isWeekend);
  expect(stats.activeMs).toBe(20 * M); expect(stats.longestMs).toBe(20 * M);
});

test("a resumed session splits at the long pause into two stretches", () => {
  const day = 4 * 86_400_000, stats = localStats([session([0, 10 * M, day, day + 25 * M, day + 50 * M])], isWeekend);
  expect(stats.activeMs).toBe(60 * M); expect(stats.longestMs).toBe(50 * M);
});

test("First Steps needs one hundred sessions", () => {
  expect(badges(localStats(many(100, [0]), isWeekend)).find((b) => b.name === "First Steps")).toMatchObject({ earned: true, progress: "Earned" });
  expect(badges(localStats(many(99, [0]), isWeekend)).find((b) => b.name === "First Steps")).toMatchObject({ earned: false, progress: "99 of 100 sessions" });
});

test("Long Haul is earned at exactly sixty active minutes", () => {
  const stats = localStats([session([0, 20 * M, 40 * M, 60 * M])], isWeekend);
  expect(stats.longestMs).toBe(60 * M);
  expect(badges(stats).find((b) => b.name === "Long Haul")).toMatchObject({ earned: true, progress: "Earned" });
});

test("Weekend Builder needs thirty percent of sessions", () => {
  const weekend = many(3, [0], WEEKEND_AT), weekdays = many(7, [0], 0);
  expect(badges(localStats([...weekend, ...weekdays], isWeekend)).find((b) => b.name === "Weekend Builder")).toMatchObject({ earned: true, progress: "Earned" });
  const two = many(2, [0], WEEKEND_AT), eight = many(8, [0], 0);
  expect(badges(localStats([...two, ...eight], isWeekend)).find((b) => b.name === "Weekend Builder")).toMatchObject({ earned: false, progress: "20% of sessions on weekends" });
});
