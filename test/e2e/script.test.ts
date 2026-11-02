// Phase 2 done-when: a 300-call task finishes in at most 3 model requests, plus Script-mode behavior
// end to end (script_only tools, background wake, permissions inside a Script, wait guard).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOpenAI } from "../fakes/fake-openai.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { RpcChild, lastToolResult, makeRepo } from "./helpers.ts";

const servers: FakeServer[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

const PROVIDERS = [
  { provider: "anthropic" as const, start: startFakeAnthropic, name: "Fake Anthropic", modelId: "custom:Fake-Anthropic-0" },
  { provider: "openai" as const, start: startFakeOpenAI, name: "Fake OpenAI", modelId: "custom:Fake-OpenAI-0" },
];

function home(p: (typeof PROVIDERS)[number], url: string, extra: Record<string, unknown> = {}): string {
  const h = mkdtempSync(join(tmpdir(), "rigwell-script-e2e-home-"));
  writeFileSync(join(h, "settings.json"), JSON.stringify({
    customModels: [{ model: `fake-${p.provider}`, displayName: p.name, provider: p.provider, baseUrl: url, apiKey: "test-key-not-real" }],
    ...extra,
  }));
  return h;
}

const script = (code: string) => ({ toolCalls: [{ name: "Script", input: { script: code } }] });

async function session(p: (typeof PROVIDERS)[number], turns: FakeTurn[], opts: { args?: string[]; settings?: Record<string, unknown>; init?: Record<string, unknown>; repo?: string } = {}) {
  const server = await p.start(turns);
  servers.push(server);
  const repo = opts.repo ?? makeRepo();
  const h = home(p, server.url, opts.settings);
  const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", ...(opts.args ?? ["--auto", "low"])], { cwd: repo, env: { RIGWELL_HOME: h } });
  const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: p.modelId, ...(opts.init ?? {}) });
  return { server, repo, home: h, c, init };
}

const toolNames = (body: any) => (body.tools ?? []).map((t: any) => t.name).sort();

describe.each(PROVIDERS)("Script mode: $provider", (p) => {
  test("300 tool calls in at most 3 model requests (mass rename across 150 files)", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "src"));
    for (let i = 0; i < 150; i++) writeFileSync(join(repo, "src", `f${i}.txt`), `line one\nconst oldName = ${i};\nuse(oldName);\n`);
    const program = [
      "const { files } = await tools.Grep({ pattern: 'oldName', path: 'src', fixed: true });",
      "const reads = await Promise.allSettled(files.map(f => tools.Read({ path: f })));",
      "const edits = await Promise.allSettled(files.map(f => tools.Edit({ path: f, old_text: 'oldName', new_text: 'newName', replaceAll: true })));",
      "print(files.length, 'files;', reads.filter(r => r.status === 'fulfilled').length, 'read;', edits.filter(r => r.status === 'fulfilled').length, 'edited');",
    ].join("\n");
    const s = await session(p, [
      { text: "Renaming everywhere in one Script.", ...script(program) },
      (body) => {
        const r = lastToolResult(body);
        const j = JSON.parse(r);
        if (j.status !== "completed" || j.tool_calls < 300) throw new Error("unexpected Script result: " + r.slice(0, 300));
        if (!j.output.includes("150 files; 150 read; 150 edited")) throw new Error("output: " + j.output);
        return { text: "Renamed oldName to newName in 150 files." };
      },
    ], { repo });
    await s.c.call("add_user_message", { text: "rename oldName to newName in src", messageId: "t1" });
    const done = await s.c.turnCompleted();
    await s.c.call("close_session", { reason: "other" });
    await s.c.close();

    expect(done.params.notification.reason).toBe("completed");
    expect(s.server.requests.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < 150; i++) {
      const t = readFileSync(join(repo, "src", `f${i}.txt`), "utf8");
      expect(t).toBe(`line one\nconst newName = ${i};\nuse(newName);\n`);
    }
    const notes = s.c.notifications();
    const inner = notes.filter((n) => n.type === "tool_result" && /^[0-9a-f-]{36}-\d+$/.test(n.toolUseId));
    expect(inner.length).toBeGreaterThanOrEqual(300);
    expect(inner[0].messageId).toBe(`repl-tool-result:${inner[0].toolUseId}`);
    expect(notes.some((n) => n.type === "tool_call" && n.toolUse.scriptExecution?.runId)).toBe(true);
    // result log: every inner result except Read is kept, with the per-run output log
    const dir = join(s.home, "artifacts", "scripts", s.init.sessionId);
    expect(existsSync(join(dir, "results.jsonl"))).toBe(true);
    const lines = readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(151);
    expect(readdirSync(dir).some((f) => f.endsWith(".log"))).toBe(true);
    // transcript: inner calls stored as user_only messages
    const tr = readdirSync(join(s.home, "sessions")).flatMap((d) => readdirSync(join(s.home, "sessions", d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(s.home, "sessions", d, f)));
    expect(tr.length).toBeGreaterThan(0);
    const text = readFileSync(tr[0]!, "utf8");
    expect(text).toContain("repl-tool-call:");
    expect(text).toContain("repl-tool-result:");
  }, 60000);

  test("script_only: only Script and script_job are sent, with the third system block", async () => {
    const s = await session(p, [{ text: "hi" }], { settings: { scriptToolModels: [p.modelId] } });
    expect(s.init.settings.toolExecutionMode).toBe("script_only");
    await s.c.call("add_user_message", { text: "hello", messageId: "t1" });
    await s.c.turnCompleted();
    await s.c.close();
    const body = s.server.requests[0];
    expect(toolNames(body)).toEqual(["AskUser", "Script", "TaskOutput", "TaskStop", "script_job"]);
    if (p.provider === "anthropic") {
      expect(body.system.length).toBe(3);
      expect(body.system[2].text).toContain("you reach tools only through Script");
    } else {
      expect(JSON.stringify(body)).toContain("you reach tools only through Script");
    }
  }, 30000);

  test("direct_only by default: core tools plus Script and script_job; override at initialize_session", async () => {
    const s = await session(p, [{ text: "hi" }]);
    expect(s.init.settings.toolExecutionMode).toBe("direct_only");
    await s.c.call("add_user_message", { text: "hello", messageId: "t1" });
    await s.c.turnCompleted();
    await s.c.close();
    expect(toolNames(s.server.requests[0])).toEqual(["AskUser", "Create", "Edit", "Execute", "FetchUrl", "Glob", "Grep", "LS", "Read", "Script", "Skill", "TaskOutput", "TaskStop", "TodoWrite", "call_tool", "load_tools", "script_job"]);

    const o = await session(p, [{ text: "hi" }], { init: { toolExecutionMode: "script_only" } });
    expect(o.init.settings.toolExecutionMode).toBe("script_only");
    await o.c.close();
  }, 30000);

  test("background Script: returns running at once, the model ends its turn, the harness wakes it", async () => {
    const s = await session(p, [
      script("//@background\nconst r = await tools.Execute({ command: 'sleep 1; echo slept', riskLevel: 'low', riskReason: 'sleep' });\nprint(r.stdout.trim());"),
      (body) => {
        const j = JSON.parse(lastToolResult(body));
        if (j.status !== "running" || !/^scr_/.test(j.job_id)) throw new Error("expected running job: " + JSON.stringify(j));
        return { text: "Started it; waiting to be woken." };
      },
      (body) => {
        const last = JSON.stringify(body);
        if (!last.includes("finished with status completed") || !last.includes("slept")) throw new Error("no wake reminder: " + last);
        return { text: "The background Script finished." };
      },
    ]);
    await s.c.call("add_user_message", { text: "run it in the background", messageId: "t1" });
    await s.c.waitFor((m) => m.params?.notification?.type === "agent_turn_completed" && m.params.notification.turnId?.startsWith("wake-"), 30000);
    await s.c.close();
    expect(s.server.requests.length).toBe(3);
    const done = s.c.notifications().filter((n) => n.type === "agent_turn_completed");
    expect(done.length).toBe(2);
    expect(done.map((n) => n.reason)).toEqual(["completed", "completed"]);
  }, 40000);

  test("Execute background:true returns a job id and wakes the model; script_job status/stop work", async () => {
    const s = await session(p, [
      { toolCalls: [{ name: "Execute", input: { command: "sleep 0.5; echo built", riskLevel: "low", riskReason: "build", background: true } }] },
      (body) => {
        const j = JSON.parse(lastToolResult(body));
        if (j.status !== "running" || !/^job_/.test(j.job_id)) throw new Error("bad: " + lastToolResult(body));
        return { text: "ok, sleeping" };
      },
      (body) => {
        if (!JSON.stringify(body).includes("built")) throw new Error("no wake with output");
        return { toolCalls: [{ name: "Execute", input: { command: "sleep 30", riskLevel: "low", riskReason: "long", background: true } }] };
      },
      (body) => {
        const id = JSON.parse(lastToolResult(body)).job_id;
        return { toolCalls: [{ name: "script_job", input: { job_id: id, action: "status" } }, { name: "script_job", input: { job_id: id, action: "stop" } }] };
      },
      (body) => {
        const m = body.messages ? body.messages.at(-1).content : body.input;
        const txt = JSON.stringify(m);
        if (!txt.includes("running") || !txt.includes("stopped")) throw new Error("status/stop results missing: " + txt.slice(0, 600));
        return { text: "stopped it" };
      },
    ]);
    await s.c.call("add_user_message", { text: "build", messageId: "t1" });
    await s.c.waitFor((m) => m.params?.notification?.type === "agent_turn_completed" && m.params.notification.turnId?.startsWith("wake-"), 30000);
    await s.c.waitFor((m) => m.params?.notification?.type === "agent_working_state_changed" && m.params.notification.newState === "idle" && s.server.requests.length >= 5, 30000);
    await s.c.close();
    expect(s.server.requests.length).toBe(5);
  }, 60000);

  test("a rejected permission inside a Script throws PermissionDenied into the program", async () => {
    const s = await session(p, [
      script("try { await tools.Execute({ command: 'echo hi > out.txt', riskLevel: 'medium', riskReason: 'writes a file' }); print('ran'); } catch (e) { print('caught', e.name); }"),
      (body) => {
        const j = JSON.parse(lastToolResult(body));
        if (!j.output.includes("caught PermissionDenied")) throw new Error("not rejected: " + lastToolResult(body));
        return { text: "The edit was refused." };
      },
    ], { args: ["--auto", "low"] });
    // autoRejectPermissionRequests is a session option; re-init is not possible, so answer the prompt with a rejection instead.
    s.c.onRequest = () => ({ selectedOption: "cancel" });
    await s.c.call("add_user_message", { text: "edit", messageId: "t1" });
    const done = await s.c.turnCompleted();
    await s.c.close();
    // "cancel" stops the turn (as for a direct call) and the program saw PermissionDenied
    expect(done.params.notification.reason).toBe("permission_rejected");
    expect(existsSync(join(s.repo, "out.txt"))).toBe(false);
    const results = s.c.notifications().filter((n) => n.type === "tool_result");
    expect(results.some((n) => /PermissionDenied/.test(n.content))).toBe(true);
  }, 30000);

  test("changing to a model with a different tool mode appends a notice", async () => {
    const a = await p.start([{ text: "one" }, { text: "two" }]);
    servers.push(a);
    const repo = makeRepo();
    const h = mkdtempSync(join(tmpdir(), "rigwell-script-e2e-home-"));
    writeFileSync(join(h, "settings.json"), JSON.stringify({
      customModels: [
        { model: "fake-direct", displayName: "Direct", provider: p.provider, baseUrl: a.url, apiKey: "k" },
        { model: "fake-script", displayName: "Scripty", provider: p.provider, baseUrl: a.url, apiKey: "k" },
      ],
      scriptToolModels: ["fake-script"],
    }));
    const c = new RpcChild(["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"], { cwd: repo, env: { RIGWELL_HOME: h } });
    const init = await c.call("initialize_session", { machineId: "default", cwd: repo, modelId: "custom:Direct-0" });
    expect(init.settings.toolExecutionMode).toBe("direct_only");
    await c.call("add_user_message", { text: "first", messageId: "t1" });
    await c.turnCompleted();
    await c.call("update_session_settings", { modelId: "custom:Scripty-1" });
    await c.waitFor((m) => m.params?.notification?.type === "settings_updated" && m.params.notification.settings.toolExecutionMode === "script_only");
    await c.call("add_user_message", { text: "second", messageId: "t2" });
    await c.waitFor((m) => m.params?.notification?.type === "agent_turn_completed" && m.params.notification.turnId === "t2");
    await c.close();
    expect(toolNames(a.requests[1])).toEqual(["AskUser", "Script", "TaskOutput", "TaskStop", "script_job"]);
    expect(JSON.stringify(a.requests[1])).toContain("The model changed");
    expect(JSON.stringify(a.requests[0])).not.toContain("The model changed");
  }, 30000);

  test("24 waits on one running Script stop the turn without stopping the Script", async () => {
    const waitCall = (id: string) => ({ toolCalls: [{ name: "script_job", input: { job_id: id, action: "wait", timeoutMs: 5 } }] });
    const turns: FakeTurn[] = [
      script("//@background\nawait tools.Execute({ command: 'sleep 20', riskLevel: 'low', riskReason: 'wait' });"),
      (body) => waitCall(JSON.parse(lastToolResult(body)).job_id),
    ];
    for (let i = 0; i < 30; i++) {
      turns.push((body) => {
        const j = JSON.parse(lastToolResult(body) || "{}");
        if (j.status !== "running") throw new Error("job ended early: " + JSON.stringify(body.messages.slice(-3)).slice(0, 900));
        return waitCall(j.job_id);
      });
    }
    const s = await session(p, turns);
    await s.c.call("add_user_message", { text: "wait forever", messageId: "t1" });
    const done = await s.c.turnCompleted();
    expect(done.params.notification.reason).toBe("completed");
    // 1 Script request + 24 wait requests
    expect(s.server.requests.length).toBe(25);
    const msgs = s.c.notifications().filter((n) => n.type === "create_message");
    expect(JSON.stringify(msgs)).toContain("has not finished after 24 waits");
    await s.c.call("close_session", { reason: "other" });
    await s.c.close();
  }, 60000);
});
