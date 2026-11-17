import { expect, test } from "bun:test";
import { DaemonBroker } from "../../desktop/main/broker.ts";
import type { AttentionEvent } from "../../src/sidepane/attention.ts";

test("broker retains Workstream attention across views, clears it on final disconnect and rearms on reconnect", async () => {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    readyState = 1;
    constructor(_url: string) { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(_text: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    status() { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "notification", method: "rigwell.session_notification", params: { notification: { type: "workstream_agent_status", leadSessionId: "lead", workstreamId: "ws", agent: { agentId: "a", name: "Builder", status: "waiting_input" } } } }) })); }
  }
  const events: AttentionEvent[] = []; let open: AttentionEvent[] = [];
  const b = new DaemonBroker(() => ({ wsUrl: "ws://localhost", token: "fixture" }), { deliver() {}, onAttention(ev, pending) { events.push(ev); open = pending; } }, Socket as unknown as typeof WebSocket);
  try {
    const a = await b.openConnection(1), c = await b.openConnection(2);
    sockets[0]!.status(); sockets[1]!.status(); expect(events).toHaveLength(1); expect(b.attentionCount).toBe(1);
    b.closeConnection(1, a); expect(b.attentionCount).toBe(1); expect(open).toHaveLength(1);
    sockets[1]!.close(); expect(b.connectionCount).toBe(0); expect(b.attentionCount).toBe(0); expect(open).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "attention_resolved", workstreamId: "ws", requestId: "workstream-ws-a" });
    await b.openConnection(3); sockets[2]!.status(); expect(b.attentionCount).toBe(1); expect(events.at(-1)!.kind).toBe("attention_requested");
    b.closeConnection(2, c); expect(b.attentionCount).toBe(1);
    b.closeAll(); expect(open).toEqual([]);
  } finally { b.closeAll(); }
});
