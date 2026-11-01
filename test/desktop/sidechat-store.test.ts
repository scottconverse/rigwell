// Side chat storage (spec 17.4): btw/ folder, btw-fork tag, prior exchanges metadata, Promote, includeBtwForks, writes switch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { rigwellHome } from "../../src/storage/paths.ts";
import { projectSessionsDir } from "../../src/storage/paths.ts";
import { connect, MODEL, startTestDaemon } from "./helpers.ts";

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

describe("side chat storage", () => {
  let fake: FakeServer, daemon: Awaited<ReturnType<typeof startTestDaemon>>;
  let repo: string;
  const sideTools: string[][] = [];

  beforeAll(async () => {
    repo = makeRepo();
    const route: FakeTurn = (body) => {
      const all = JSON.stringify(body.messages);
      const isToolResult = Array.isArray(body.messages.at(-1).content) && body.messages.at(-1).content.some((b: any) => b.type === "tool_result");
      const last = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (all.includes("This is a side conversation")) {
        sideTools.push(body.tools.map((t: any) => t.name));
        if (last.includes("Q-WRITE")) return isToolResult ? { text: "wrote it" } : { toolCalls: [{ name: "Create", input: { path: "side-wrote.txt", content: "x" } }] };
        return { text: `side answer to ${last.includes("Q-B") ? "B" : "A"}` };
      }
      return { text: "main says hi" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 40 }, () => route));
    daemon = await startTestDaemon(fake.url, {});
  });
  afterAll(() => { daemon.d.stop(); fake.stop(); });

  test("a fork is stored under btw/ with the btw-fork tag, hidden from lists, and Promote makes it a normal session", async () => {
    const c = await connect(daemon.d.socketPath);
    const { sessionId } = await c.call("initialize_session", { cwd: repo, modelId: MODEL, autonomyLevel: "high" });
    await c.call("add_user_message", { text: "hello" });
    await c.waitFor((n) => n.type === "agent_turn_completed");

    const a = await c.call("daemon.side_chat_ask", { question: "Q-A what happened?" });
    const doneA = await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === a.entry.id && n.entry.status === "complete");
    const forkA = doneA.entry.forkId as string;
    expect(typeof forkA).toBe("string");

    const btw = join(rigwellHome(), "sessions", "btw");
    expect(existsSync(join(btw, `${forkA}.jsonl`))).toBe(true);
    const settings = JSON.parse(readFileSync(join(btw, `${forkA}.settings.json`), "utf8"));
    expect(settings.tags.map((t: any) => t.name)).toEqual(["btw-fork"]);
    const transcript = readFileSync(join(btw, `${forkA}.jsonl`), "utf8");
    expect(transcript).toContain("main says hi");
    expect(transcript).toContain("side answer to A");
    expect(JSON.parse(transcript.split("\n")[0]!).parent).toBe(sessionId);

    // A second question after the fork closed forks again and records the first exchange on its tag.
    await new Promise((r) => setTimeout(r, 200));
    const b = await c.call("daemon.side_chat_ask", { question: "Q-B and then?" });
    const doneB = await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === b.entry.id && n.entry.status === "complete");
    expect(doneB.entry.forkId).not.toBe(forkA);
    const tagB = JSON.parse(readFileSync(join(btw, `${doneB.entry.forkId}.settings.json`), "utf8")).tags[0];
    expect(tagB.metadata.priorExchanges).toEqual([{ question: "Q-A what happened?", answer: "side answer to A" }]);

    // Lists hide forks unless includeBtwForks is set.
    const hidden = await c.call("daemon.list_sessions", {});
    expect(hidden.sessions.some((s: any) => s.id === forkA)).toBe(false);
    const shown = await c.call("daemon.list_sessions", { includeBtwForks: true });
    expect(shown.sessions.some((s: any) => s.id === forkA)).toBe(true);
    const rows = await c.call("list_sessions", {});
    expect(rows.sessions.some((s: any) => s.sessionId === forkA)).toBe(false);
    expect((await c.call("list_sessions", { includeBtwForks: true })).sessions.some((s: any) => s.sessionId === forkA)).toBe(true);

    // Promote: the tag goes, the files move into the project folder, the session is a normal one.
    const p = await c.call("daemon.side_chat_promote", { entryId: a.entry.id });
    expect(p.sessionId).toBe(forkA);
    expect(existsSync(join(btw, `${forkA}.jsonl`))).toBe(false);
    const dest = projectSessionsDir(repo);
    expect(existsSync(join(dest, `${forkA}.jsonl`))).toBe(true);
    const moved = JSON.parse(readFileSync(join(dest, `${forkA}.settings.json`), "utf8"));
    expect((moved.tags ?? []).some((t: any) => t.name === "btw-fork")).toBe(false);
    expect(moved.title).toStartWith("Side chat: Q-A what happened?");
    const after = await c.call("list_sessions", {});
    expect(after.sessions.find((s: any) => s.sessionId === forkA)?.title).toStartWith("Side chat:");
    const entries = (await c.call("daemon.side_chat_list", {})).entries;
    expect(entries.find((e: any) => e.id === a.entry.id).promotedTo).toBe(forkA);
    // Promoting again is harmless; the promoted session loads and continues like any other.
    expect((await c.call("daemon.side_chat_promote", { entryId: a.entry.id })).sessionId).toBe(forkA);
    const r = await connect(daemon.d.socketPath);
    const loaded = await r.call("load_session", { sessionId: forkA, cwd: repo });
    expect(JSON.stringify(loaded.session.messages)).toContain("side answer to A");
    await r.close();
    await c.close();
  }, 60_000);

  test("writes are off in the fork until the user turns them on", async () => {
    const c = await connect(daemon.d.socketPath);
    await c.call("initialize_session", { cwd: repo, modelId: MODEL, autonomyLevel: "high" });
    await c.call("add_user_message", { text: "hello again" });
    await c.waitFor((n) => n.type === "agent_turn_completed");
    expect((await c.call("daemon.side_chat_list", {})).writes).toBe(false);

    sideTools.length = 0;
    const off = await c.call("daemon.side_chat_ask", { question: "Q-WRITE please create a file" });
    await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === off.entry.id && (n.entry.status === "complete" || n.entry.status === "error"));
    expect(existsSync(join(repo, "side-wrote.txt"))).toBe(false);
    expect(sideTools.every((t) => !t.includes("Create") && !t.includes("Edit"))).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect((await c.call("daemon.side_chat_set_writes", { enabled: true })).writes).toBe(true);
    expect((await c.call("daemon.side_chat_list", {})).writes).toBe(true);
    sideTools.length = 0;
    const on = await c.call("daemon.side_chat_ask", { question: "Q-WRITE now it is on" });
    await c.waitFor((n) => n.type === "daemon.side_chat_entry" && n.entry.id === on.entry.id && n.entry.status === "complete");
    expect(sideTools.some((t) => t.includes("Create"))).toBe(true);
    expect(existsSync(join(repo, "side-wrote.txt"))).toBe(true);
    await expect(c.call("daemon.side_chat_set_writes", { enabled: "yes" })).rejects.toThrow();
    await c.close();
  }, 60_000);
});
