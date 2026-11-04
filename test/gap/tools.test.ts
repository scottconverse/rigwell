// LS, FetchUrl, ApplyPatch, TaskOutput/TaskStop, TodoWrite, AskUser.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplyPatchTool, parsePatch } from "../../src/tools/apply-patch.ts";
import { createFetchUrlTool, htmlToText } from "../../src/tools/fetch-url.ts";
import { createLsTool } from "../../src/tools/ls.ts";
import { decide } from "../../src/permissions/gate.ts";
import { DEFAULT_COMMAND_LISTS } from "../../src/permissions/lists.ts";
import { call, makeStubSession, text } from "../agent/helpers.ts";

const ctx = (cwd: string): any => ({ cwd, sessionId: "s", readFiles: new Map(), signal: new AbortController().signal });
const tmp = () => mkdtempSync(join(tmpdir(), "rigwell-gap-"));
const flat = (v: unknown) => JSON.stringify(v);

describe("LS", () => {
  test("lists a folder, hides ignored and bulky entries, descends with depth, returns structured data", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, ".gitignore"), "secret.txt\nout/\n");
    writeFileSync(join(d, "a.txt"), "hello");
    writeFileSync(join(d, "secret.txt"), "x");
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "deep.ts"), "1");
    mkdirSync(join(d, "out"));
    mkdirSync(join(d, "node_modules"));
    const ls = createLsTool();
    const r = await ls.run({}, ctx(d));
    expect(r.content).toContain("a.txt  (5 bytes)");
    expect(r.content).toContain("src/");
    expect(r.content).not.toContain("secret.txt");
    expect(r.content).not.toContain("node_modules");
    expect(r.content).not.toContain("deep.ts");
    expect((r.data as any).entries.map((e: any) => e.name)).toEqual([".gitignore", "src/", "a.txt"].sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)));
    const deep = await ls.run({ depth: 2 }, ctx(d));
    expect(deep.content).toContain("src/deep.ts");
    const all = await ls.run({ includeIgnored: true }, ctx(d));
    expect(all.content).toContain("secret.txt");
    expect(all.content).toContain("node_modules/");
    const custom = await ls.run({ ignore: ["*.txt"] }, ctx(d));
    expect(custom.content).not.toContain("a.txt");
    expect((await ls.run({ path: join(d, "a.txt") }, ctx(d))).isError).toBe(true);
    expect(decide("LS", {}, { autonomy: "off", interactionMode: "auto", skipPermissions: false, lists: DEFAULT_COMMAND_LISTS, cwd: d }).decision).toBe("allow");
  });
});

describe("FetchUrl", () => {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/page") return new Response("<html><head><title>My Page</title><style>p{}</style></head><body><h1>Hi &amp; welcome</h1><script>evil()</script><p>First <a href='/x'>link</a></p><ul><li>one</li><li>two</li></ul></body></html>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/json") return Response.json({ ok: true });
      if (u.pathname === "/long") return new Response("word ".repeat(5000), { headers: { "content-type": "text/plain" } });
      if (u.pathname === "/img") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      return new Response("nope", { status: 404 });
    },
  });
  afterAll(() => void server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const fetchTool = createFetchUrlTool();

  test("HTML becomes text; scripts and styles are dropped; links are kept", async () => {
    const r = await fetchTool.run({ url: `${base}/page` }, ctx(tmp()));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("My Page");
    expect(r.content).toContain("Hi & welcome");
    expect(r.content).toContain("link (/x)");
    expect(r.content).toContain("- one");
    expect(r.content).not.toContain("evil()");
    expect(r.content).not.toContain("<h1>");
    expect(htmlToText("<p>a&nbsp;b</p><br>c")).toBe("a b\n\nc");
  });
  test("size cap, JSON passthrough, errors", async () => {
    const long = await fetchTool.run({ url: `${base}/long`, maxChars: 1000 }, ctx(tmp()));
    expect(long.content).toContain("[Cut at 1000 of 25000 characters");
    expect((await fetchTool.run({ url: `${base}/json` }, ctx(tmp()))).content).toContain('{"ok":true}');
    expect((await fetchTool.run({ url: `${base}/missing` }, ctx(tmp()))).isError).toBe(true);
    expect((await fetchTool.run({ url: `${base}/img` }, ctx(tmp()))).isError).toBe(true);
    expect((await fetchTool.run({ url: "file:///etc/passwd" }, ctx(tmp()))).isError).toBe(true);
    expect((await fetchTool.run({ url: "http://127.0.0.1:1/" }, ctx(tmp()))).isError).toBe(true);
  });
  test("permission: ask at off, auto at low and above", () => {
    const base = { interactionMode: "auto" as const, skipPermissions: false, lists: DEFAULT_COMMAND_LISTS, cwd: "/tmp" };
    const off = decide("FetchUrl", { url: "http://x" }, { ...base, autonomy: "off" });
    expect(off.decision).toBe("ask");
    expect((off as any).confirmationType).toBe("fetch_url");
    expect(decide("FetchUrl", { url: "http://x" }, { ...base, autonomy: "low" }).decision).toBe("allow");
  });
});

describe("ApplyPatch", () => {
  test("adds, updates and deletes; a bad hunk writes nothing", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(d, "gone.txt"), "bye\n");
    const c = ctx(d);
    const tool = createApplyPatchTool();
    // not read yet
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** Add File: new/b.txt\n+hello\n+world\n*** Delete File: gone.txt\n*** End Patch";
    expect((await tool.run({ input: patch }, c)).content).toContain("has not been read");
    for (const f of ["a.txt", "gone.txt"]) {
      const st = (await import("node:fs")).statSync(join(d, f));
      c.readFiles.set(join(d, f), { mtimeMs: st.mtimeMs, size: st.size });
    }
    const bad = "*** Begin Patch\n*** Add File: z.txt\n+z\n*** Update File: a.txt\n@@\n-nothere\n+x\n*** End Patch";
    expect((await tool.run({ input: bad }, c)).isError).toBe(true);
    expect(() => readFileSync(join(d, "z.txt"))).toThrow();
    const r = await tool.run({ input: patch }, c);
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(readFileSync(join(d, "new/b.txt"), "utf8")).toBe("hello\nworld\n");
    expect(() => readFileSync(join(d, "gone.txt"))).toThrow();
  });
  test("the grammar is checked", () => {
    expect(() => parsePatch("*** Update File: a\n")).toThrow(/Begin Patch/);
    expect(() => parsePatch("*** Begin Patch\n*** Frob: a\n*** End Patch")).toThrow(/expected/);
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a\nplain\n*** End Patch")).toThrow(/start with/);
    expect(parsePatch("*** Begin Patch\n*** Delete File: a\n*** End Patch")).toEqual([{ kind: "delete", path: "a" }]);
  });
  test("asks at off with an apply_patch confirmation and is blocked outside spec plan files", () => {
    const base = { skipPermissions: false, lists: DEFAULT_COMMAND_LISTS, cwd: "/tmp/w" };
    const p = "*** Begin Patch\n*** Add File: x.txt\n+1\n*** End Patch";
    const off = decide("ApplyPatch", { input: p }, { ...base, autonomy: "off", interactionMode: "auto" });
    expect((off as any).confirmationType).toBe("apply_patch");
    expect(decide("ApplyPatch", { input: p }, { ...base, autonomy: "low", interactionMode: "auto" }).decision).toBe("allow");
    expect(decide("ApplyPatch", { input: p }, { ...base, autonomy: "low", interactionMode: "spec" }).decision).toBe("block");
  });
});

describe("TaskOutput and TaskStop", () => {
  test("collect a finished background command; stop a running one", async () => {
    const jobIds: string[] = [];
    const s = makeStubSession((req, n) => {
      const last = flat(req.messages.at(-1));
      const id = /job_[a-f0-9]{12}/.exec(last)?.[0] ?? "";
      if (n === 0) return call("Execute", { command: "echo done-quick", background: true, riskLevel: "low", riskReason: "echo" }, "e1");
      if (n === 1) { jobIds.push(id); return call("TaskOutput", { task_id: id, block: true, timeoutMs: 5000 }, "o1"); }
      if (n === 2) return call("Execute", { command: "sleep 30", background: true, riskLevel: "low", riskReason: "sleep" }, "e2");
      if (n === 3) { jobIds.push(id); return call("TaskStop", { task_id: id }, "k1"); }
      return text("end");
    });
    s.session.addUserMessage("go");
    await s.session.settled();
    const outputs = s.requests.map((r) => flat(r.messages.at(-1)));
    expect(outputs[2]).toContain("done-quick");
    expect(outputs[2]).toContain('\\"status\\":\\"completed\\"');
    expect(outputs[4]).toContain("stopped");
    expect(jobIds.length).toBe(2);
    expect(s.session.jobs.get(jobIds[1]!)?.status).not.toBe("running");
  }, 20000);
  test("an unknown id lists the known ones", async () => {
    const s = makeStubSession((req, n) => (n === 0 ? call("TaskOutput", { task_id: "nope" }, "o1") : text("end")));
    s.session.addUserMessage("go");
    await s.session.settled();
    expect(flat(s.requests[1]!.messages.at(-1))).toContain("No job with id");
  });
});

describe("TodoWrite and AskUser", () => {
  const host = (extra: Record<string, unknown> = {}, notes?: any[]) => ({ notify: (n: any) => notes?.push(n), requestPermission: async () => ({ selectedOption: "proceed_once" }), ...extra }) as any;

  test("TodoWrite keeps the list, persists todo_state, nudges once at turn end, and compaction carries it", async () => {
    const saved: any[] = [];
    const s = makeStubSession((req, n) => {
      if (n === 0) return call("TodoWrite", { todos: [{ content: "write tests", status: "in_progress" }, { content: "ship", status: "pending" }] }, "t1");
      if (n === 1) return text("all done");
      if (n === 2) return call("TodoWrite", { todos: [{ content: "write tests", status: "completed" }, { content: "ship", status: "completed" }] }, "t2");
      return text("really done");
    }, {
      autoRejectPermissionRequests: false,
      persistence: { appendMessage: async () => {}, appendTurnOutcome: async () => {}, saveSettings: async () => {}, appendTodoState: async (todos: any, idx: number) => { saved.push({ todos, idx }); } },
    });
    s.session.setHost(host({}, s.notes));
    s.session.addUserMessage("do the work");
    await s.session.settled();
    expect(s.requests[0]!.tools.map((t) => t.name)).toContain("TodoWrite");
    // the model said "all done" with open items: one nudge, then it finished the list
    expect(flat(s.requests[2]!.messages.at(-1))).toContain("todo list still has 2 open items");
    expect(s.requests.length).toBe(4);
    expect(saved.length).toBe(2);
    expect(saved[1].todos.every((t: any) => t.status === "completed")).toBe(true);
    expect(s.notes.filter((n) => n.type === "todo_state_changed").length).toBe(2);
    expect(s.session.getTodos().length).toBe(2);
  });

  test("the todos block is rebuilt from the list at compaction and the threshold reserve grows", async () => {
    const s = makeStubSession((req, n) => (n === 0 ? call("TodoWrite", { todos: [{ content: "alpha task", status: "pending" }] }, "t1") : text("ok")), { autoRejectPermissionRequests: false });
    s.session.setHost(host());
    const before = s.session.compactionThreshold();
    s.session.addUserMessage("first");
    await s.session.settled();
    expect(s.session.compactionThreshold()).toBeLessThan(before);
    expect(s.session.carriedTokens()).toBeGreaterThan(0);
    const refreshed = (s.session as any).refreshedContext(["<environment>\n</environment>", "<todos>\nNo todo list yet.\n</todos>"]);
    expect(refreshed[1]).toContain("- [pending] alpha task");
  });

  test("AskUser sends rigwell.ask_user and returns the answers; no client means cancelled; plain exec has no AskUser", async () => {
    const asked: any[] = [];
    const s = makeStubSession((req, n) => (n === 0 ? call("AskUser", { questions: [{ topic: "DB", question: "Which database?", options: ["sqlite", "postgres"] }] }, "q1") : text("thanks")), { autoRejectPermissionRequests: false });
    s.session.setHost(host({ requestAskUser: async (p: any) => { asked.push(p); return { answers: [{ index: 1, question: "Which database?", answer: "sqlite" }] }; } }, s.notes));
    s.session.addUserMessage("pick");
    await s.session.settled();
    expect(asked[0].questions[0]).toMatchObject({ index: 1, topic: "DB", options: ["sqlite", "postgres"] });
    expect(typeof asked[0].requestId).toBe("string");
    expect(flat(s.requests[1]!.messages.at(-1))).toContain("sqlite");
    expect(s.notes.filter((n) => n.type === "agent_working_state_changed").map((n) => n.newState)).toContain("waiting_for_tool_confirmation");

    // a host that dismisses
    const s2 = makeStubSession((req, n) => (n === 0 ? call("AskUser", { questions: [{ topic: "t", question: "q?", options: ["a", "b"] }] }, "q1") : text("ok")), { autoRejectPermissionRequests: false });
    s2.session.setHost(host({ requestAskUser: async () => ({ cancelled: true, answers: [] }) }));
    s2.session.addUserMessage("x");
    await s2.session.settled();
    expect(flat(s2.requests[1]!.messages.at(-1))).toContain("did not answer");

    // headless: the tool is not offered at all
    const s3 = makeStubSession(() => text("hi"));
    s3.session.addUserMessage("x");
    await s3.session.settled();
    expect(s3.requests[0]!.tools.map((t) => t.name)).not.toContain("AskUser");
    expect(s3.requests[0]!.tools.map((t) => t.name)).not.toContain("TodoWrite");
  });
});
