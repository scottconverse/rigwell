// Side chat (spec 17.4): a question is answered while the main turn is still running, without touching the main session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { jsCommand } from "../platform.ts";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { priorExchangesText, settledPrefix, SIDE_CHAT_PREAMBLE } from "../../src/sidepane/sidechat.ts";
import { connect, MODEL, startTestDaemon } from "./helpers.ts";

describe("settledPrefix", () => {
  const m = (role: "user" | "assistant", content: any[], id = Math.random().toString()) => ({ id, role, content }) as any;
  test("cuts at the last assistant message that ends a turn", () => {
    const msgs = [
      m("user", [{ type: "text", text: "a" }]), m("assistant", [{ type: "text", text: "done" }]),
      m("user", [{ type: "text", text: "b" }]), m("assistant", [{ type: "tool_use", id: "1", name: "Read", input: {} }]),
      m("user", [{ type: "tool_result", toolUseId: "1", content: "x" }]),
    ];
    expect(settledPrefix(msgs)).toEqual(msgs.slice(0, 2));
    expect(settledPrefix(msgs.slice(0, 1))).toEqual([]);
  });
  test("prior exchanges are limited to 10 and clipped", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ id: String(i), question: "q" + i + "x".repeat(2000), answer: "a" + i + "y".repeat(6000), status: "complete" as const, createdAt: 0 }));
    const t = priorExchangesText(entries);
    expect(t).not.toContain("Q11: q0"); // oldest two dropped
    expect(t.match(/^Q\d+:/gm)!.length).toBe(10);
    expect(t.length).toBeLessThan(10 * 5200);
  });
});

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

describe("side chat while the main agent works", () => {
  let fake: FakeServer, daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let repo: string;
  const sideBodies: any[] = [];
  const mainBodies: any[] = [];

  beforeAll(async () => {
    repo = makeRepo();
    const route: FakeTurn = (body) => {
      const all = JSON.stringify(body.messages);
      const lastMsg = body.messages.at(-1);
      const isToolResult = Array.isArray(lastMsg.content) && lastMsg.content.some((b: any) => b.type === "tool_result");
      const userTexts = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean);
      const lastUserText = userTexts.at(-1) ?? "";
      if (all.includes("This is a side conversation")) {
        sideBodies.push(body);
        if (lastUserText.includes("Q-WRITE")) {
          return isToolResult ? { text: "I could not write the file." } : { toolCalls: [{ name: "Create", input: { path: "side-wrote.txt", content: "x" } }] };
        }
        if (lastUserText.includes("Q-TWO")) return { text: `answer two (prior exchange seen: ${all.includes("answer one") ? "yes" : "no"})` };
        return { text: `answer one: the main agent said ${all.includes("hi there") ? "hi there" : "nothing"}` };
      }
      mainBodies.push(body);
      if (isToolResult) return { text: "long work finished" };
      if (lastUserText.includes("LONG")) {
        return { toolCalls: [{ name: "Execute", input: { command: jsCommand(tmpdir(), `const fs = require("fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(repo, "GATE"))})) { clearInterval(t); console.log("released"); } }, 50);`), riskLevel: "low", riskReason: "waits for a file" } }] };
      }
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 60 }, () => route));
    daemon = await startTestDaemon(fake.url, {});
  });
  afterAll(() => { daemon.d.stop(); fake.stop(); });

  test("answers arrive while the main turn is still executing a tool", async () => {
    const c = await connect(daemon.d.socketPath);
    const { sessionId } = await c.call("initialize_session", { cwd: repo, modelId: MODEL, autonomyLevel: "high" });
    await c.call("add_user_message", { text: "hello" });
    await c.waitFor((n) => n.type === "agent_turn_completed");

    // Start a long main turn and wait until its tool is running.
    await c.call("add_user_message", { text: "LONG task please" });
    await c.waitFor((n) => n.type === "agent_working_state_changed" && n.newState === "executing_tool");
    const turnsBefore = c.notes.filter((n) => n.type === "agent_turn_completed").length;

    const asked = await c.call("daemon.side_chat_ask", { question: "Q-ONE what did the agent say?" });
    expect(asked.entry.status).toBe("pending");
    const complete = await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === asked.entry.id && n.entry.status === "complete");
    expect(complete.entry.answer).toBe("answer one: the main agent said hi there");
    // streaming updates were delivered before completion
    expect(c.notes.some((n) => n.type === "daemon.side_chat_entry" && n.entry.id === asked.entry.id && n.entry.status === "streaming")).toBe(true);

    // The main turn is still running, untouched.
    expect(c.notes.filter((n) => n.type === "agent_turn_completed").length).toBe(turnsBefore);
    expect(existsSync(join(repo, "GATE"))).toBe(false);

    // A second question queues behind nothing, forks again and carries the first exchange.
    const second = await c.call("daemon.side_chat_ask", { question: "Q-TWO and another?" });
    const done2 = await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === second.entry.id && n.entry.status === "complete");
    expect(done2.entry.answer).toBe("answer two (prior exchange seen: yes)");

    // Read-only: a side question that tries to write is refused and nothing is created.
    const w = await c.call("daemon.side_chat_ask", { question: "Q-WRITE please create a file" });
    await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === w.entry.id && (n.entry.status === "complete" || n.entry.status === "error"));
    expect(existsSync(join(repo, "side-wrote.txt"))).toBe(false);
    expect(sideBodies.every((b) => !b.tools.some((t: any) => t.name === "Create" || t.name === "Edit"))).toBe(true);

    // Release the main agent; it finishes normally.
    writeFileSync(join(repo, "GATE"), "go");
    const mainDone = await c.waitFor((n) => n.type === "agent_turn_completed" && c.notes.filter((x) => x.type === "agent_turn_completed").indexOf(n) === turnsBefore);
    expect(mainDone.reason).toBe("completed");

    // Isolation: the main transcript and the main model requests never saw the side conversation.
    const list = await c.call("daemon.side_chat_list", {});
    expect(list.entries.length).toBe(3);
    expect(mainBodies.every((b) => !JSON.stringify(b).includes("side conversation") && !JSON.stringify(b).includes("Q-ONE"))).toBe(true);
    const reloaded = await connect(daemon.d.socketPath);
    const lr = await reloaded.call("load_session", { sessionId, cwd: repo });
    expect(JSON.stringify(lr.session.messages)).not.toContain("Q-ONE");
    expect(JSON.stringify(lr.session.messages)).toContain("long work finished");
    await reloaded.close();
    // The fork was built with the preamble, not the main session's queue.
    expect(JSON.stringify(sideBodies[0])).toContain(SIDE_CHAT_PREAMBLE.slice(0, 40));
    await c.close();
  }, 60_000);
});
