// Phase 5 wiring points in the loop, with a scripted in-process model: instructions, skills, hooks, spec mode, Task.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HookRunner, loadHooksConfig } from "../../src/hooks/index.ts";
import { TaskLimits } from "../../src/subagents/task.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { jsCommand } from "../platform.ts";
import { call, makeStubSession, text } from "./helpers.ts";

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => { env = tmpEnv(); });
afterEach(() => env.cleanup());

const flat = (r: any) => JSON.stringify(r.messages);
const hooks = (extra: Record<string, unknown>) => (a: any) =>
  new HookRunner({ config: loadHooksConfig({ cwd: a.cwd ?? process.cwd(), extra }), sessionId: a.sessionId, transcriptPath: a.transcriptPath, cwd: process.cwd(), permissionMode: a.permissionMode, notify: a.notify });
const sh = (command: string) => ({ type: "command", command });

test("instructions and skills ride in the first message in prompts.md order; lazy finds arrive next turn", async () => {
  const { session, requests, cwd } = makeStubSession((req, n) => (n === 0 ? call("Read", { path: "sub/f.txt" }) : text("ok")));
  // files must exist before the session loads them: recreate the session after writing
  mkdirSync(path.join(cwd, "sub"), { recursive: true });
  writeFileSync(path.join(cwd, "CLAUDE.md"), "ROOT RULES");
  writeFileSync(path.join(cwd, "sub", "f.txt"), "x\n");
  writeFileSync(path.join(cwd, "sub", "AGENTS.md"), "SUB RULES");
  mkdirSync(path.join(cwd, ".rigwell", "skills", "deploy"), { recursive: true });
  writeFileSync(path.join(cwd, ".rigwell", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nRun the deploy steps carefully, one at a time, and report each.\n");
  const again = makeStubSession((req, n) => (n === 0 ? call("Read", { path: "sub/f.txt" }) : text("ok")), { cwd } as any);
  void session;
  again.session.addUserMessage("go");
  await again.session.idle();
  const first = again.requests[0]!.messages[0]!.content.map((b: any) => b.text.split("\n")[0]);
  expect(first).toEqual(["<environment>", "<project_instructions>", "<skills>", "<session>", "<todos>"]);
  expect(again.requests[0]!.tools.map((t) => t.name)).toContain("Skill");
  expect(flat(again.requests[0])).toContain("ROOT RULES");
  expect(flat(again.requests[1])).not.toContain("SUB RULES"); // found during the turn, reminder next turn
  again.session.addUserMessage("again");
  await again.session.idle();
  expect(flat(again.requests[2])).toContain("SUB RULES");
  void requests;
});

test("no skills: no Skill tool", async () => {
  const { session, requests } = makeStubSession(() => text("hi"));
  session.addUserMessage("go");
  await session.idle();
  expect(requests[0]!.tools.map((t) => t.name)).not.toContain("Skill");
});

test("hooks: PreToolUse deny, PostToolUse context, Stop sends the agent back once", async () => {
  const stopFile = path.join(mkdtempSync(path.join(tmpdir(), "rigwell-hk-")), "stopped");
  const h = hooks({
    PreToolUse: [{ matcher: "Grep", hooks: [sh(jsCommand(path.dirname(stopFile), `console.error("no grep today"); process.exit(2);`))] }],
    PostToolUse: [{ matcher: "Read", hooks: [sh(jsCommand(path.dirname(stopFile), `console.log("post-read-context");`))] }],
    Stop: [{ hooks: [sh(jsCommand(path.dirname(stopFile), `const fs = require("fs"); const f = ${JSON.stringify(stopFile)}; if (fs.existsSync(f)) process.exit(0); fs.writeFileSync(f, ""); console.error("run the tests first"); process.exit(2);`))] }],
  });
  const { session, requests, notes } = makeStubSession((req, n) => {
    if (n === 0) return { content: [{ type: "tool_use", id: "a", name: "Grep", input: { pattern: "x" } }, { type: "tool_use", id: "b", name: "Read", input: { path: "a.txt" } }] };
    return text(n === 1 ? "done?" : "really done");
  }, { hooksFor: h });
  session.addUserMessage("go");
  await session.idle();
  const second = flat(requests[1]!);
  expect(second).toContain("Blocked by a hook: no grep today");
  expect(second).toContain("post-read-context");
  expect(requests.length).toBe(3);
  expect(flat(requests[2]!)).toContain("run the tests first");
  expect(notes.filter((n) => n.type === "hook_execution_started").map((n) => n.hookEventName)).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse", "Stop"]));
});

test("hooks: UserPromptSubmit can block the prompt", async () => {
  const { session, requests, notes } = makeStubSession(() => text("hi"), { hooksFor: hooks({ UserPromptSubmit: [{ hooks: [sh(jsCommand(env.root, `console.error("nope"); process.exit(2);`))] }] }) });
  session.addUserMessage("go");
  await session.idle();
  expect(requests.length).toBe(0);
  expect(notes.find((n) => n.type === "agent_turn_completed").reason).toBe("prompt_rejected");
});

test("hooks: a rewritten Execute command drops the model's risk fields and asks", async () => {
  const h = hooks({ PreToolUse: [{ matcher: "Execute", hooks: [sh(jsCommand(env.root, `console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: "echo rewritten" } } }));`))] }] });
  const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("Execute", { command: "echo hi", riskLevel: "low", riskReason: "r" }) : text("ok")), { hooksFor: h, settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "auto", autonomyLevel: "medium" } });
  session.addUserMessage("go");
  await session.idle();
  // autoRejectPermissionRequests is on in the stub: the unrated command was asked about, and rejected
  expect(flat(requests[1]!)).toContain("rejected");
});

test("spec mode: ExitSpecMode only while on and interactive; approval saves the spec and ends the mode", async () => {
  const { session, requests, cwd } = makeStubSession((req, n) => (n === 0 ? call("ExitSpecMode", { title: "Fix greet", plan: "# Plan\n1. fix it" }) : text("ok")), {
    settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "spec", autonomyLevel: "off" }, autoRejectPermissionRequests: false,
  });
  const asked: any[] = [];
  (session as any).host.requestPermission = async (p: any) => { asked.push(p); return { selectedOption: "proceed_auto_run_medium" }; };
  session.addUserMessage("plan it");
  await session.idle();
  expect(requests[0]!.tools.map((t) => t.name)).toContain("ExitSpecMode");
  expect(requests[0]!.tools.map((t) => t.name)).toContain("Create"); // plan files can be written even at autonomy off
  expect(asked[0].toolUses[0].confirmationType).toBe("exit_spec_mode");
  expect(asked[0].toolUses[0].details).toMatchObject({ plan: "# Plan\n1. fix it", title: "Fix greet" });
  expect(asked[0].options.map((o: any) => o.value)).toEqual(["proceed_once", "proceed_auto_run_low", "proceed_auto_run_medium", "proceed_auto_run_high", "proceed_edit", "proceed_new_session", "proceed_new_session_low", "proceed_new_session_medium", "proceed_new_session_high", "cancel"]);
  expect(session.settings).toMatchObject({ interactionMode: "auto", autonomyLevel: "medium" });
  expect(flat(requests[1]!)).toContain("Spec mode has ended");
  const docs = path.join(cwd, ".rigwell", "docs");
  expect(readFileSync(path.join(docs, readdirSync(docs)[0]!), "utf8")).toContain("1. fix it");
  expect(requests[1]!.tools.map((t) => t.name)).not.toContain("ExitSpecMode");
});

test("spec mode: not offered when headless", async () => {
  const { session, requests } = makeStubSession(() => text("x"), { settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "spec", autonomyLevel: "off" } });
  session.addUserMessage("go");
  await session.idle();
  expect(requests[0]!.tools.map((t) => t.name)).not.toContain("ExitSpecMode");
});

test("Task: a child session runs in process with its own transcript and its usage rolls up", async () => {
  const opened: any[] = [];
  const childStored: any[] = [];
  const { session, requests, notes } = makeStubSession((req, n) => {
    if (n === 0) return call("Task", { description: "look around", prompt: "list files", background: false }, "task1");
    if (n === 1) return text("child report: 1 file"); // the child's only reply
    return text("parent done");
  }, {
    settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "auto", autonomyLevel: "high" },
    subagents: {
      limits: new TaskLimits(), agents: [], depth: 0, rootSessionId: "root",
      openChild: (o) => { opened.push(o); return { transcriptPath: "/x", persistence: { appendMessage: async (m) => { childStored.push(m); }, appendTurnOutcome: async () => {}, saveSettings: async () => {} } }; },
    },
  });
  session.addUserMessage("delegate");
  await session.idle();
  expect(requests[0]!.tools.map((t) => t.name)).toContain("Task");
  expect(requests[1]!.tools.map((t) => t.name)).not.toContain("Task"); // children never get Task
  expect(flat(requests[1]!)).toContain("list files");
  expect(flat(requests[1]!)).not.toContain("delegate"); // the child starts from the prompt only
  expect(opened[0]).toMatchObject({ callingSessionId: session.id, callingToolUseId: "task1", depth: 1 });
  expect(flat(requests[2]!)).toContain("child report: 1 file");
  expect(childStored.length).toBeGreaterThan(0);
  const done = notes.filter((n) => n.type === "agent_turn_completed").at(-1);
  expect(done.cumulativeTokenUsage.inputTokens).toBe(30);
  expect(session.inclusiveUsage().inputTokens).toBe(30);
  expect(existsSync("/x")).toBe(false);
});

test("Task is not offered below high autonomy", async () => {
  const { session, requests } = makeStubSession(() => text("x"), {
    subagents: { limits: new TaskLimits(), agents: [], depth: 0, rootSessionId: "r", openChild: () => { throw new Error("no"); } },
    settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "auto", autonomyLevel: "medium" },
  });
  session.addUserMessage("go");
  await session.idle();
  expect(requests[0]!.tools.map((t) => t.name)).not.toContain("Task");
});
