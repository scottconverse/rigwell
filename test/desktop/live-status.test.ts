// Live agent status: the session state, the current step and the Agents tab rows.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepFrom } from "../../src/agent/step.ts";
import { liveStateFrom, liveStates, publishLiveStates, registerLiveSession, watchLiveStates } from "../../src/machines/live-sessions.ts";
import type { AgentEntry } from "../../src/workstreams/store.ts";
import { applyAgentEvent, memberRows, needsAgentReload, workerAgentRows } from "../../desktop/renderer/lib/agents.ts";
import { applySessionState, clearSessionStates, normalizeSession, runningWorkstreams, sessionStateLabel, type SessionRow } from "../../desktop/renderer/lib/sessions.ts";

type LiveSession = Parameters<typeof registerLiveSession>[0];
const fake = (id: string, workingState: string): LiveSession & { workingState: string } => ({
  id, workingState, isRunning: workingState !== "idle", hasBackgroundWork: () => false, queuedMessages: () => [], stopForFleet: async () => {},
});
function withHome(run: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "rigwell-live-")), old = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = home;
  try { run(home); } finally {
    if (old === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
}
const agent = (over: Partial<AgentEntry>) => ({ agentId: "a1", name: "A very long agent name that must stay whole", role: "worker", sessionId: "s1", status: "working", tokens: 5, ...over }) as AgentEntry;

describe("session live state", () => {
  test("maps each working state", () => {
    expect(liveStateFrom(undefined)).toBe("idle");
    expect(liveStateFrom("idle")).toBe("idle");
    expect(liveStateFrom("waiting_for_tool_confirmation")).toBe("waiting");
    for (const s of ["thinking", "streaming_assistant_message", "executing_tool", "compacting_conversation"]) expect(liveStateFrom(s)).toBe("working");
  });
  test("waiting wins when two engines share one session id", () => withHome((home) => {
    const a = fake("s", "thinking"), b = fake("s", "waiting_for_tool_confirmation");
    const offA = registerLiveSession(a), offB = registerLiveSession(b);
    expect(liveStates(home).get("s")).toBe("waiting");
    offB(); offA();
  }));
  test("sends one message per change, and a closed session goes idle", () => withHome((home) => {
    const seen: [string, string][] = [], s = fake("s", "thinking");
    const off = watchLiveStates((id, state) => seen.push([id, state]), home);
    const close = registerLiveSession(s);
    publishLiveStates(); publishLiveStates();
    expect(seen).toEqual([["s", "working"]]);
    s.workingState = "waiting_for_tool_confirmation"; publishLiveStates();
    close();
    expect(seen).toEqual([["s", "working"], ["s", "waiting"], ["s", "idle"]]);
    off();
  }));
  test("a client that throws does not stop the session", () => withHome((home) => {
    const off = watchLiveStates(() => { throw new Error("closed"); }, home), close = registerLiveSession(fake("s", "thinking"));
    expect(() => publishLiveStates()).not.toThrow();
    close(); off();
  }));
});

describe("current step", () => {
  test("reads the state and tool notifications", () => {
    expect(stepFrom({ type: "agent_working_state_changed", newState: "thinking" })).toBe("Thinking");
    expect(stepFrom({ type: "agent_working_state_changed", newState: "idle" })).toBe("");
    expect(stepFrom({ type: "agent_working_state_changed", newState: "executing_tool" })).toBeUndefined();
    expect(stepFrom({ type: "tool_call", toolUse: { name: "Edit" } })).toBe("Running Edit");
    expect(stepFrom({ type: "assistant_text_delta" })).toBeUndefined();
  });
});

describe("sidebar model", () => {
  const rows = [{ id: "a", title: "A", updatedAt: 1 }, { id: "b", title: "B", updatedAt: 2 }] as SessionRow[];
  test("changes one row and keeps the order", () => {
    const next = applySessionState(rows, "b", "waiting");
    expect(next.map((r) => r.id)).toEqual(["a", "b"]);
    expect(sessionStateLabel(next[1])).toBe("Waiting for you");
    expect(applySessionState(next, "b", "waiting")).toBe(next);
    expect(sessionStateLabel(applySessionState(next, "b", "idle")[1])).toBe("Idle");
  });
  test("a lost connection leaves no row Working", () => {
    expect(clearSessionStates(applySessionState(rows, "a", "working")).some((r) => r.state)).toBe(false);
  });
  test("reads the state from list_sessions", () => {
    expect(normalizeSession({ sessionId: "x", state: "working", updatedAt: "2026-01-01T00:00:00Z" }).state).toBe("working");
    expect(normalizeSession({ sessionId: "x", state: "idle", updatedAt: "2026-01-01T00:00:00Z" }).state).toBeUndefined();
  });
  test("lists only running and paused workstreams", () => {
    const list = ["proposed", "active", "paused", "completed", "archived"].map((state) => ({ id: state, title: state, state }));
    expect(runningWorkstreams(list).map((w) => w.id)).toEqual(["active", "paused"]);
  });
});

describe("Agents tab rows", () => {
  test("hides archived members and keeps the full name", () => {
    const rows = memberRows([agent({ currentStep: "Running Edit" }), agent({ agentId: "a2", status: "archived" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("A very long agent name that must stay whole");
    expect(rows[0].step).toBe("Running Edit");
  });
  test("a stopped member does not show as active or keep its step", () => {
    const [row] = memberRows([agent({ status: "interrupted", currentStep: "Thinking" })]);
    expect(row.status).toBe("Stopped");
    expect(row.active).toBe(false);
    expect(row.step).toBeUndefined();
  });
  test("only the current mission worker is Working", () => {
    const features = [{ id: "f1", description: "Add login", workerSessionIds: ["w1", "w2"] }] as never;
    const rows = workerAgentRows(features, { workerSessionId: "w2", featureId: "f1", description: "Add login", startedAt: 10, step: "Thinking" });
    expect(rows.map((r) => r.status)).toEqual(["Not running", "Working"]);
    expect(workerAgentRows(features, null).every((r) => !r.active)).toBe(true);
  });
  test("applies live changes", () => {
    const rows = memberRows([agent({})]);
    expect(applyAgentEvent(rows, { type: "workstream_agent_status", agent: agent({ status: "failed" }) })[0].status).toBe("Failed");
    expect(applyAgentEvent(rows, { type: "workstream_agent_status", agent: agent({ status: "archived" }) })).toHaveLength(0);
    const worker = workerAgentRows([] as never, { workerSessionId: "w", featureId: "f", description: "d", startedAt: 1 });
    expect(applyAgentEvent(worker, { type: "mission_worker_activity", workerSessionId: "w", step: "Running Bash" })[0].step).toBe("Running Bash");
    expect(needsAgentReload("mission_worker_completed")).toBe(true);
    expect(needsAgentReload("mission_worker_activity")).toBe(false);
  });
});
