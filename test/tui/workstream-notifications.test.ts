import { expect, test } from "bun:test";
import { initialState, reduce } from "../../src/tui/reducer.ts";

test("TUI reports all Workstream attention categories outside the overlay and deduplicates status versus prompt", () => {
  let s = initialState({ cwd: "/fixture" });
  const status = { type: "workstream_agent_status", workstreamId: "ws", agent: { agentId: "a", name: "Builder", status: "waiting_input" } };
  const need = reduce(s, { type: "notification", n: status, now: 1 }); expect(need.effects).toContainEqual({ type: "attention", kind: "awaiting" }); expect(need.state.items.some((i) => i.kind === "info" && i.text.includes("needs your input"))).toBe(true); s = need.state;
  expect(reduce(s, { type: "notification", n: status, now: 2 }).effects).toEqual([]);
  const prompt = reduce(s, { type: "request", id: "q", method: "ask_user", params: { workstreamId: "ws", agentId: "a", agentName: "Builder", workstreamTitle: "Build", questions: [{ question: "Choose?", options: ["A", "B"] }] } }); expect(prompt.state.panels).toHaveLength(1); expect(prompt.effects).not.toContainEqual({ type: "attention", kind: "awaiting" });
  const fail = reduce(s, { type: "notification", n: { ...status, agent: { ...status.agent, status: "failed" } }, now: 3 }); expect(fail.state.items.some((i) => i.kind === "info" && i.text.includes("stopped with a problem"))).toBe(true); expect(fail.effects).toContainEqual({ type: "attention", kind: "awaiting" });
  const budget = reduce(fail.state, { type: "notification", n: { type: "workstream_budget_reached", workstreamId: "ws", reason: "Token limit" }, now: 4 }); expect(budget.state.items.some((i) => i.kind === "info" && i.text.includes("Workstream budget reached"))).toBe(true); expect(budget.effects).toContainEqual({ type: "attention", kind: "awaiting" });
});

test("TUI prompt-first delivery deduplicates sound, refreshes an open view and rearms after resolution", () => {
  let s = initialState({ cwd: "/fixture" });
  const prompt = reduce(s, { type: "request", id: "q", method: "ask_user", params: { workstreamId: "ws", agentId: "a", agentName: "Builder", workstreamTitle: "Build", questions: [{ question: "Choose?", options: ["A", "B"] }] } });
  expect(prompt.effects).toContainEqual({ type: "attention", kind: "awaiting" }); s = { ...prompt.state, overlay: { title: "Build", lines: [], workstreamId: "ws" } };
  const n = { type: "workstream_agent_status", workstreamId: "ws", agent: { agentId: "a", name: "Builder", status: "waiting_input" } };
  const duplicate = reduce(s, { type: "notification", n, now: 1 }); expect(duplicate.effects).toEqual([{ type: "view", name: "workstreams", args: "ws", refresh: true }]);
  const idle = reduce(duplicate.state, { type: "notification", n: { ...n, agent: { ...n.agent, status: "idle" } }, now: 2 }); expect(idle.effects).not.toContainEqual({ type: "attention", kind: "awaiting" });
  const again = reduce(idle.state, { type: "notification", n, now: 3 }); expect(again.effects).toContainEqual({ type: "attention", kind: "awaiting" });
  const budget = { type: "workstream_budget_reached", workstreamId: "ws", reason: "Limit" };
  const stop = reduce(again.state, { type: "notification", n: budget, now: 4 });
  for (const state of ["active", "archived"]) {
    const clear = reduce(stop.state, { type: "notification", n: { type: "workstream_updated", workstreamId: "ws", workstream: { state } }, now: 5 });
    expect(clear.effects).not.toContainEqual({ type: "attention", kind: "awaiting" });
    expect(reduce(clear.state, { type: "notification", n: budget, now: 6 }).effects).toContainEqual({ type: "attention", kind: "awaiting" });
  }
});
