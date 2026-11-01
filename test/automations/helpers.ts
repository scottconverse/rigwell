import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeHome } from "../e2e/helpers.ts";
import { AutomationManager } from "../../src/automations/manager.ts";
import { createHeadlessRunner } from "../../src/automations/runner.ts";

export class FakeClock {
  constructor(public t: number) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
  set(iso: string) { this.t = Date.parse(iso); }
}

export const servers: FakeServer[] = [];

/** Temp RIGWELL_HOME with one fake Anthropic model, a manager on a fake clock, and the real headless runner. */
export async function setup(script: FakeTurn[], startIso = "2026-03-01T00:00:00Z") {
  const server = await startFakeAnthropic(script);
  servers.push(server);
  const home = makeHome([{ provider: "anthropic", url: server.url, displayName: "Fake Anthropic" }]);
  process.env.RIGWELL_HOME = home;
  const clock = new FakeClock(Date.parse(startIso));
  const work = mkdtempSync(join(tmpdir(), "rigwell-auto-work-"));
  const mgr = new AutomationManager({
    runner: createHeadlessRunner({ retryBaseDelayMs: 1 }), clock,
  });
  return { server, home, clock, mgr, work };
}
