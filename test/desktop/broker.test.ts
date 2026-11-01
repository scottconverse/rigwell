// The main-process broker against a real daemon: routing per window, ownership checks, attention events from a real
// permission request and turn completion.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { DaemonBroker } from "../../desktop/main/broker.ts";
import type { AttentionEvent } from "../../src/sidepane/attention.ts";
import { startTestDaemon, sleep } from "./helpers.ts";

let fake: FakeServer;
let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
beforeAll(async () => {
  fake = await startFakeAnthropic([
    { toolCalls: [{ name: "Execute", input: { command: "echo hi > out.txt", riskLevel: "medium", riskReason: "writes a file" } }] },
    { text: "All done here.\nSecond line." },
  ]);
  daemon = await startTestDaemon(fake.url, {}, { port: 0 });
});
afterAll(() => { daemon.d.stop(); fake.stop(); });

describe("DaemonBroker", () => {
  test("routes by window, enforces ownership, and raises attention events", async () => {
    const delivered: { w: number; channel: string; payload: any }[] = [];
    const attention: AttentionEvent[] = [];
    let openNow: AttentionEvent[] = [];
    const broker = new DaemonBroker(() => ({ wsUrl: daemon.d.wsUrl!, token: daemon.d.wsToken! }), {
      deliver: (w, channel, payload) => delivered.push({ w, channel, payload }),
      onAttention: (ev, open) => { attention.push(ev); openNow = open; },
    });
    const a = await broker.openConnection(1);
    const b = await broker.openConnection(2);
    expect(() => broker.send(2, a, "{}")).toThrow("Unknown connection"); // window 2 cannot use window 1's connection
    expect(() => broker.send(1, a, 5 as any)).toThrow("strings");

    const repo = makeRepo();
    const req = (id: string, method: string, params: any) => JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: "rigwell." + method, params });
    broker.send(1, a, req("i1", "initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0", autonomyLevel: "off" }));
    const wait = async (pred: () => boolean) => { for (let i = 0; i < 300 && !pred(); i++) await sleep(25); expect(pred()).toBe(true); };
    await wait(() => delivered.some((d) => d.payload?.message?.includes('"id":"i1"')));
    broker.send(1, a, req("m1", "add_user_message", { text: "run it" }));

    await wait(() => attention.some((e) => e.requestKind === "permission"));
    const perm = attention.find((e) => e.requestKind === "permission")!;
    expect(perm.summary).toContain("echo hi > out.txt");
    expect(openNow.length).toBe(1);
    // Only window 1 received traffic; window 2's connection stayed quiet.
    expect(delivered.every((d) => d.w === 1)).toBe(true);
    const permReq = delivered.filter((d) => d.channel === "daemon:message").map((d) => JSON.parse(d.payload.message)).find((m) => m.method === "rigwell.request_permission");
    broker.send(1, a, JSON.stringify({ jsonrpc: "2.0", type: "response", id: permReq.id, result: { selectedOption: "proceed_once" } }));

    await wait(() => attention.some((e) => e.requestKind === "session_completion"));
    expect(attention.some((e) => e.kind === "attention_resolved" && e.requestId === permReq.id)).toBe(true);
    const done = attention.find((e) => e.requestKind === "session_completion")!;
    expect(done.summary).toBe("All done here.");
    expect(openNow.length).toBe(0);

    broker.closeWindow(1);
    expect(broker.connectionCount).toBe(1); // window 1's connection closed with its window; window 2's is untouched
    // If the daemon goes away, the window that owns a live connection is told.
    daemon.d.stop();
    await wait(() => delivered.some((d) => d.w === 2 && d.channel === "daemon:closed" && d.payload.connId === b));
    expect(broker.connectionCount).toBe(0);
  }, 30_000);
});
