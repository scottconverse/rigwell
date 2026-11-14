import { expect, test } from "bun:test";
import { AttentionTracker } from "../../src/sidepane/attention.ts";
import { notificationFor, badgeCount, soundFor } from "../../desktop/main/alerts.ts";
import { DEFAULT_SETTINGS } from "../../desktop/main/settings.ts";
import { reduce } from "../../desktop/renderer/lib/transcript.ts";
import { SessionController } from "../../desktop/renderer/lib/session.ts";

test("workstream attention is deduplicated across views and routes input, failures and budget events", () => {
  const t = new AttentionTracker(), status = { type: "workstream_agent_status", workstreamId: "ws", agent: { agentId: "a", name: "Builder", status: "waiting_input" } };
  const [need] = t.onNotification("lead", status);
  expect(need!.category).toBe("workstream_needs_input");
  expect(t.onNotification("lead", status)).toEqual([]);
  expect(t.onRequest("lead", "ask_user", "rpc", { workstreamId: "ws" })).toBeUndefined();
  expect(notificationFor(need!, DEFAULT_SETTINGS, { focused: false })!.route).toBe("/workstreams/ws");
  expect(badgeCount([need!, need!])).toBe(1);
  expect(soundFor(need!, DEFAULT_SETTINGS, { focused: false })).toBeDefined();
  expect(t.onNotification("lead", { ...status, agent: { ...status.agent, status: "idle" } })[0]!.kind).toBe("attention_resolved");
  const [failed] = t.onNotification("lead", { ...status, agent: { ...status.agent, status: "failed" } });
  expect(notificationFor(failed!, DEFAULT_SETTINGS, { focused: false })!.title).toBe("Stopped with a problem");
  const budget = { type: "workstream_budget_reached", workstreamId: "ws", reason: "Token limit" };
  expect(t.onNotification("lead", budget)[0]!.category).toBe("workstream_budget_reached");
  expect(t.onNotification("lead", budget)).toEqual([]);
  t.onNotification("lead", { type: "workstream_updated", workstreamId: "ws", workstream: { state: "active" } });
  expect(t.onNotification("lead", budget)).toHaveLength(1);
});

test("committed user messages deduplicate optimistic messages and preserve transcript order", () => {
  const initial = [{ kind: "user" as const, id: "u:0", text: "Question" }];
  const n = { type: "create_message", message: { id: "u", role: "user", content: [{ type: "text", text: "Question" }] } };
  expect(reduce(initial, n)).toEqual(initial);
  const next = reduce(initial, { ...n, message: { ...n.message, id: "peer" } });
  expect(next.map((m) => m.id)).toEqual(["u:0", "peer:0"]);
});

test("lead turn completion leaves independent member questions open until a user answer or member completion", async () => {
  const ctl = new (SessionController as any)("fixture"), c = ctl as any;
  let answered = false;
  const p = c.onRequest("ask_user", { requestId: "member-question", workstreamId: "ws", agentId: "a", questions: [] }).then(() => { answered = true; });
  c.onNotification("session_notification", { notification: { type: "agent_turn_completed", reason: "completed" } });
  await Promise.resolve(); expect(answered).toBe(false); expect(ctl.getSnapshot().prompts).toHaveLength(1);
  c.onNotification("session_notification", { notification: { type: "workstream_prompt_resolved", workstreamId: "ws", requestId: "member-question", answer: { answers: [] } } });
  await p; expect(answered).toBe(true); expect(ctl.getSnapshot().prompts).toHaveLength(0);
});
