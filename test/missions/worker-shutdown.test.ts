// A worker outcome must resolve even when connection shutdown never finishes: shutdown waits for session idle,
// background jobs and session end, and one of those can hang. The wait is bounded so the mission cannot hang.
import { describe, expect, test } from "bun:test";
import { boundedShutdown, WORKER_SHUTDOWN_WAIT_MS } from "../../src/missions/worker.ts";

describe("mission worker bounded shutdown", () => {
  test("resolves when shutdown never resolves", async () => {
    let started = false;
    const never = { shutdown: () => { started = true; return new Promise<never>(() => {}); } };
    const t0 = Date.now();
    await boundedShutdown(never, 100);
    expect(started).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("returns as soon as shutdown finishes", async () => {
    let finished = false;
    const quick = { shutdown: async () => { finished = true; } };
    const t0 = Date.now();
    await boundedShutdown(quick, 5_000);
    expect(finished).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("swallows a shutdown rejection", async () => {
    const bad = { shutdown: async () => { throw new Error("session end failed"); } };
    await boundedShutdown(bad, 5_000);
  });

  test("the production bound is a few seconds, not unbounded", () => {
    expect(WORKER_SHUTDOWN_WAIT_MS).toBeGreaterThanOrEqual(1_000);
    expect(WORKER_SHUTDOWN_WAIT_MS).toBeLessThanOrEqual(10_000);
  });
});
