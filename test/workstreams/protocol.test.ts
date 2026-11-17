import { expect, test } from "bun:test";
import { createConnection } from "../../src/daemon/connection.ts";
import { setup, until } from "./helpers.ts";

test("protocol watchers receive changes, user messages cannot forge their sender, and lifecycle methods validate ids", async () => {
  const f = await setup();
  const notes: any[] = [], unrelated: any[] = [];
  const watch = f.service.attach({ session: () => undefined, notify: (n) => notes.push(n), request: async () => ({}) });
  const other = f.service.attach({ session: () => undefined, notify: (n) => unrelated.push(n), request: async () => ({}) });
  try {
    const m = watch.methods;
    expect(m.list_workstreams().workstreams.map((w) => w.id)).toContain(f.store.id);
    expect(m.get_workstream({ id: f.store.id }).roster[0]!.sessionId).toBe(f.first.sessionId);
    m.pause_workstream({ id: f.store.id });
    m.workstream_send({ id: f.store.id, to: f.first.agentId, message: "USER MESSAGE", from: "lead", priority: "later" });
    expect(f.store.messages().at(-1)!.from).toBe("user");
    expect(f.store.messages().at(-1)!.deliveredAt).toBeUndefined();
    expect(notes.some((n) => n.type === "workstream_updated")).toBe(true);
    expect(notes.some((n) => n.type === "workstream_message")).toBe(true);
    expect(unrelated).toEqual([]);
    await m.resume_workstream({ id: f.store.id }); await f.member.connection.session!.idle();
    expect(JSON.stringify(f.fake.requests)).toContain("USER MESSAGE");
    expect(() => m.get_workstream({ id: "../escape" })).toThrow("Invalid Workstream id");
    expect(() => m.workstream_interrupt({ id: "missing", agentId: f.first.agentId })).toThrow("No such Workstream");
    m.workstream_interrupt({ id: f.store.id, agentId: f.first.agentId });
    await m.workstream_archive_agent({ id: f.store.id, agentId: f.first.agentId });
    expect(f.store.agent(f.first.agentId)!.status).toBe("archived");
    await m.archive_workstream({ id: f.store.id }); expect(f.store.read().state).toBe("archived");
  } finally { watch.close(); other.close(); await f.close(); }
});

test("live transcript views share the owned engine, show pending questions and close without stopping a member", async () => {
  const f = await setup((body) => JSON.stringify(body.messages.at(-1)).includes("BUSY") ? { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Choice", question: "Continue?", options: ["yes", "no"] }] } }] } : { text: "Finished" });
  const messages: any[] = [], pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>(); let seq = 0;
  const view = createConnection((line) => {
    for (const text of line.split("\n").filter(Boolean)) {
      const m = JSON.parse(text); messages.push(m);
      if (m.type === "response") { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result); }
    }
  }, { canPrompt: true, sharedSession: f.service.sharedSession });
  const call = (method: string, params: any) => new Promise<any>((resolve, reject) => {
    const id = String(++seq); pending.set(id, { resolve, reject }); view.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
  });
  try {
    await f.member.call("add_user_message", { text: "BUSY" }); await until(() => f.prompts.length > 0);
    const loaded = await call("load_session", { sessionId: f.first.sessionId, cwd: f.member.connection.session!.cwd });
    expect(view.session!).toBe(f.member.connection.session!);
    expect(loaded.pendingAskUserRequests).toHaveLength(1);
    const detail = f.attached.methods.get_workstream({ id: f.store.id });
    expect(detail.pendingPrompts[0]!.params.agentName).toBe("First");
    expect(detail.pendingPrompts[0]!.params.workstreamTitle).toBe("Messaging");
    const p = detail.pendingPrompts[0]!;
    f.attached.methods.workstream_answer_request({ id: f.store.id, agentId: f.first.agentId, requestId: p.requestId, answer: { answers: { Choice: "yes" } } });
    await f.member.connection.session!.idle();
    expect(messages.some((m) => m.params?.notification?.type === "agent_turn_completed")).toBe(true);
    await call("close_session", {}); await view.shutdown();
    expect(f.service.members.has(f.first.agentId)).toBe(true);
    await f.member.call("add_user_message", { text: "STILL RUNNING" }); await f.member.connection.session!.idle();
    expect(JSON.stringify(f.fake.requests)).toContain("STILL RUNNING");
    expect(f.store.agent(f.first.agentId)!.status).toBe("idle");
  } finally { await view.shutdown(); await f.close(); }
});
