// A mission that handed control back to the orchestrator must not read as working when that turn cannot continue.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionStore } from "../../src/missions/store.ts";
import { pauseOrchestratorTurn } from "../../src/missions/index.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); });
function store() {
  const dir = mkdtempSync(join(tmpdir(), "rigwell-turn-")); roots.push(dir);
  const s = new MissionStore(dir); s.ensure(); s.writeState({ workingDirectory: dir, state: "orchestrator_turn" });
  return s;
}

test("a spend-blocked orchestrator turn pauses the mission", () => {
  const s = store();
  pauseOrchestratorTurn(s, "model_request_rejected");
  expect(s.stateName()).toBe("paused");
  expect(s.readState()?.pauseReason).toBe("model_request_rejected");
});

test("a completed or cancelled turn leaves the mission state alone", () => {
  for (const reason of ["completed", "cancelled"]) {
    const s = store();
    pauseOrchestratorTurn(s, reason);
    expect(s.stateName()).toBe("orchestrator_turn");
  }
});

test("a mission not waiting on the orchestrator is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rigwell-turn-")); roots.push(dir);
  const s = new MissionStore(dir); s.ensure(); s.writeState({ workingDirectory: dir, state: "running" });
  pauseOrchestratorTurn(s, "model_provider_unreachable");
  expect(s.stateName()).toBe("running");
});
