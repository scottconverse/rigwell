// Wave 3 TUI: display settings, spec handoff option, secret-scan prompt, /btw, org labels and ceiling.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeHome, makeRepo } from "../e2e/helpers.ts";
import { inProcessTransport } from "../../src/sdk/in-process.ts";
import { runTui } from "../../src/tui/app.ts";
import { render, stripAnsi } from "../../src/tui/render.ts";
import { diffBody } from "../../src/tui/diff.ts";
import { driver, ev, key, note, type } from "./helpers.ts";

const plain = (d: ReturnType<typeof driver>, w = 90, h = 40) => render(d.s, { width: w, height: h, color: false }).lines.map(stripAnsi).join("\n");
const OPTIONS = [{ label: "Yes", value: "proceed_once" }, { label: "No", value: "cancel" }];
const display = (d: ReturnType<typeof driver>, over: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ev(d, { type: "display", display: over as any, managed: [], ...extra } as any);

describe("display settings", () => {
  test("diffMode: github (default) and unified", () => {
    const req = { type: "request" as const, id: "e", method: "request_permission", params: { options: OPTIONS, toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "Edit", input: {} }, confirmationType: "edit", details: { fileName: "a.ts", oldContent: "one\ntwo\nthree", newContent: "one\n2\nthree" } }] } };
    const gh = ev(driver(), req);
    expect(gh.s.panels[0].body).toEqual(expect.arrayContaining(["a.ts  +1 -1", "- two", "+ 2"]));
    const un = ev(display(driver(), { diffMode: "unified" }), req);
    expect(un.s.panels[0].body).toEqual(expect.arrayContaining(["--- a/a.ts", "+++ b/a.ts", "-two", "+2", " one"]));
    expect(un.s.panels[0].body.some((l) => l.startsWith("@@ -1,3 +1,3 @@"))).toBe(true);
    expect(diffBody(undefined, "x\ny", "unified", "n.txt")[2]).toBe("@@ -0,0 +1,2 @@");
  });

  test("todoDisplayMode: pinned shows the list above the prompt, inline puts it in the transcript", () => {
    const todos = [{ id: "1", content: "write tests", status: "in_progress" }, { id: "2", content: "ship", status: "pending" }, { id: "3", content: "plan", status: "completed" }];
    let d = note(driver(), { type: "todo_state_changed", todos });
    expect(d.s.items.some((i) => i.kind === "todos")).toBe(false);
    const p = plain(d);
    expect(p).toContain("Todos (1/3 done)");
    expect(p).toContain("[~] write tests");
    expect(p).toContain("[x] plan");
    d = note(display(driver(), { todoDisplayMode: "inline" }), { type: "todo_state_changed", todos });
    expect(d.s.items.filter((i) => i.kind === "todos")).toHaveLength(1);
    const q = plain(d);
    expect(q).not.toContain("Todos (");
    expect(q).toContain("[~] write tests");
    d = note(d, { type: "todo_state_changed", todos: todos.slice(0, 1) }); // replaces the list at the end of the transcript
    expect(d.s.items.filter((i) => i.kind === "todos")).toHaveLength(1);
  });

  test("toolResultDisplay: compact hides results until Ctrl+O, expanded shows them", () => {
    const run = (d: ReturnType<typeof driver>) => {
      d = note(d, { type: "tool_call", toolUse: { id: "t1", name: "Execute", input: { command: "echo hi" } } });
      return note(d, { type: "tool_result", toolUseId: "t1", content: "line1\nline2", isError: false });
    };
    expect(plain(run(driver()))).not.toContain("line2");
    const open = plain(run(display(driver(), { toolResultDisplay: "expanded" })));
    expect(open).toContain("line1");
    expect(open).toContain("line2");
    expect(plain(key(run(driver()), "ctrl+o"))).toContain("line2");
  });

  test("Edit calls show a diff in the chosen mode when details are open", () => {
    const call = { type: "tool_call", toolUse: { id: "t", name: "Edit", input: { path: "a.ts", old_text: "x", new_text: "y" } } };
    let d = note(note(display(driver(), { toolResultDisplay: "expanded" }), call), { type: "tool_result", toolUseId: "t", content: "ok", isError: false });
    expect(plain(d)).toContain("- x");
    d = note(note(display(driver(), { toolResultDisplay: "expanded", diffMode: "unified" }), call), { type: "tool_result", toolUseId: "t", content: "ok", isError: false });
    expect(plain(d)).toContain("--- a/a.ts");
  });

  test("outputStyle: compact drops blank lines, plain drops bullets", () => {
    const withText = (d: ReturnType<typeof driver>) => note(note(d, { type: "assistant_text_delta", messageId: "m", blockIndex: 0, textDelta: "hello" }), { type: "assistant_text_delta", messageId: "m2", blockIndex: 0, textDelta: "again" });
    expect(plain(withText(driver()))).toContain("● hello");
    const pl = plain(withText(display(driver(), { outputStyle: "plain" })));
    expect(pl).not.toContain("●");
    expect(pl).toContain("hello");
    const countLines = (d: ReturnType<typeof driver>) => d.s.items.length;
    expect(countLines(withText(driver()))).toBe(2);
  });

  test("streamAssistantResponses off: the live message shows once it is finished", () => {
    let d = display(driver(), { streamAssistantResponses: false });
    d = ev(d, { type: "key", key: { name: "char", text: "x" }, now: 1 });
    d = { ...d, s: { ...d.s, running: true } };
    d = note(d, { type: "assistant_text_delta", messageId: "m", blockIndex: 0, textDelta: "secret streaming words" });
    expect(plain(d)).not.toContain("secret streaming words");
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    expect(plain(d)).toContain("secret streaming words");
    // default streams
    let s = { ...driver(), };
    s = { ...s, s: { ...s.s, running: true } };
    s = note(s, { type: "assistant_text_delta", messageId: "m", blockIndex: 0, textDelta: "visible now" });
    expect(plain(s)).toContain("visible now");
  });

  test("showThinkingInMainView turns thinking text on", () => {
    let d = note(driver(), { type: "thinking_text_delta", messageId: "m", blockIndex: 0, textDelta: "pondering" });
    expect(plain(d)).not.toContain("pondering");
    d = ev(d, { type: "display", display: {}, managed: [], showThinking: true } as any);
    expect(plain(d)).toContain("pondering");
  });
});

describe("spec handoff in the TUI", () => {
  const specReq = {
    type: "request" as const, id: "s1", method: "request_permission",
    params: {
      options: [{ label: "Yes, proceed", value: "proceed_once" }, { label: "Hand off to a new session at medium", value: "proceed_new_session_medium" }, { label: "No", value: "cancel" }],
      toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "ExitSpecMode", input: {} }, confirmationType: "exit_spec_mode", details: { plan: "# Plan", title: "T", filePath: "/p/s.md", contextSavingsPercent: 62, supportsClientStartedHandoff: true } }],
    },
  };
  test("the option shows the context saved and the answer carries clientStartsHandoffSession", () => {
    let d = ev(driver(), specReq);
    const labels = d.s.panels[0].options.map((o) => o.label);
    expect(labels).toContain("Hand off to a new session at medium (62% context saved)");
    d = type(d, "2");
    const ans = d.effects.find((e) => e.type === "answer") as any;
    expect(ans.result).toMatchObject({ selectedOption: "proceed_new_session_medium", clientStartsHandoffSession: true });
    // other options do not carry the flag
    const d2 = type(ev(driver(), specReq), "1");
    expect((d2.effects.find((e) => e.type === "answer") as any).result.clientStartsHandoffSession).toBeUndefined();
  });
  test("spec_handoff then turn end opens the new session", () => {
    let d = note(driver(), { type: "spec_handoff", specHandoffId: "abc", autonomyLevel: "medium", contextSavingsPercent: 62 });
    expect(d.effects.some((e) => e.type === "handoff")).toBe(false);
    d = note(d, { type: "agent_turn_completed", reason: "spec_handoff" });
    expect(d.effects.find((e) => e.type === "handoff")).toEqual({ type: "handoff", specHandoffId: "abc" });
    expect(d.s.items.some((i) => i.kind === "info" && i.level === "error")).toBe(false);
  });
});

describe("secret-scan prompt", () => {
  test("shows what was found without the secret and offers the three outcomes", () => {
    const d = ev(driver(), {
      type: "request", id: "x", method: "request_permission",
      params: {
        options: [{ label: "Proceed anyway", value: "proceed_once" }, { label: "Proceed & report false positive", value: "proceed_report_false_positive" }, { label: "Cancel", value: "cancel" }],
        toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "Execute", input: {} }, confirmationType: "secret_scan_violation", details: { fullCommand: "git commit -m x", count: 1, title: "Possible secrets in the changes to commit", findings: [{ rule: "aws-access-key-id", description: "AWS access key id", file: "cfg.ts", line: 3, preview: "AKIA..." }] } }],
      },
    });
    expect(d.s.panels[0].title).toBe("Possible secrets in the changes to commit");
    const p = plain(d);
    expect(p).toContain("AWS access key id  cfg.ts:3");
    expect(p).toContain("Proceed & report false positive");
    const answered = type(d, "2");
    expect((answered.effects.find((e) => e.type === "answer") as any).result.selectedOption).toBe("proceed_report_false_positive");
  });
});

describe("org policy in the TUI", () => {
  test("/settings labels managed values and Ctrl+L stops at the ceiling", () => {
    let d = ev(driver({ autonomy: "off" }), { type: "display", display: { diffMode: "unified" }, managed: ["diffMode", "maxAutonomyLevel"], maxAutonomy: "low" } as any);
    d = key(type(d, "/settings"), "enter");
    const p = d.s.overlay!.lines.join("\n");
    expect(p).toMatch(/diffMode:\s+unified\s+\[managed by org\]/);
    expect(p).toMatch(/max low\s+\[managed by org\]/);
    expect(p).not.toMatch(/outputStyle:.*managed by org/);
    d = { ...d, s: { ...d.s, overlay: null } };
    d = key(d, "ctrl+l"); // off -> low
    expect(d.s.autonomy).toBe("low");
    d = key(d, "ctrl+l"); // capped: back to off, never medium
    expect(d.s.autonomy).toBe("off");
  });
});

describe("/btw", () => {
  test("the command asks the side chat; entries from notifications show in the transcript", () => {
    let d = key(type(driver(), "/btw what is a monad"), "enter");
    expect(d.effects.find((e) => e.type === "btw")).toEqual({ type: "btw", question: "what is a monad" });
    d = note(d, { type: "daemon.side_chat_entry", entry: { id: "q1", question: "what is a monad", answer: "", status: "pending" } });
    d = note(d, { type: "daemon.side_chat_entry", entry: { id: "q1", question: "what is a monad", answer: "A burrito.", status: "complete" } });
    expect(d.s.items.filter((i) => i.kind === "btw")).toHaveLength(1);
    expect(plain(d)).toContain("btw> what is a monad");
    expect(plain(d)).toContain("A burrito.");
    expect(key(type(driver(), "/btw"), "enter").effects.some((e) => e.type === "btw")).toBe(false);
  });
  test("/btw is allowed while the agent is running (it does not ask to stop the run)", () => {
    let d = driver();
    d = { ...d, s: { ...d.s, running: true } };
    d = key(type(d, "/btw quick"), "enter");
    expect(d.s.panels).toEqual([]);
    expect(d.effects.some((e) => e.type === "btw")).toBe(true);
  });
});

describe("/btw end to end (in-process TUI, side-chat fork)", () => {
  const servers: FakeServer[] = [];
  const prev = { h: process.env.RIGWELL_HOME };
  afterEach(() => { servers.splice(0).forEach((s) => s.stop()); if (prev.h === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prev.h; });
  test("the fork answers; the main transcript is untouched", async () => {
    const model = await startFakeAnthropic([{ text: "main answer" }, { text: "side answer" }]);
    servers.push(model);
    const home = makeHome([{ provider: "anthropic", url: model.url, displayName: "F" }]);
    process.env.RIGWELL_HOME = home;
    const repo = makeRepo();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += c; });
    // The screen is only drawn on a terminal, so watch the protocol messages instead.
    const wire: string[] = [];
    const tapped = async () => {
      const t = inProcessTransport();
      let handler: (m: string) => void = () => {};
      Object.defineProperty(t, "onMessage", { get: () => (m: string) => { wire.push(m); handler(m); }, set: (h) => { handler = h; } });
      return t;
    };
    const done = runTui({ cwd: repo, makeTransport: tapped, sessionParams: { modelId: "custom:F-0" }, stdin: stdin as any, stdout: stdout as any });
    const until = async (pred: () => any, ms = 20000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout: " + wire.slice(-3).join("\n").slice(0, 600)); await Bun.sleep(5); } };
    await Bun.sleep(300);
    stdin.write("hello\r");
    await until(() => model.requests.length === 1);
    await Bun.sleep(100);
    stdin.write("/btw what happened\r");
    await until(() => model.requests.length === 2);
    await until(() => wire.some((m) => m.includes("daemon.side_chat_entry") && m.includes("side answer") && m.includes("complete")));
    // the side answer never reached the main conversation
    expect(wire.some((m) => m.includes("assistant_text_delta") && m.includes("side answer"))).toBe(false);
    // the fork request holds the main conversation and the question; the main session was not asked again
    const second = JSON.stringify(model.requests[1]);
    expect(second).toContain("main answer");
    expect(second).toContain("what happened");
    expect(second).toContain("separate copy");
    stdin.end();
    expect(await done).toBe(0);
  }, 40000);
});
