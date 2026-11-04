import { describe, expect, test } from "bun:test";
import { driver, ev, key, note, type } from "./helpers.ts";

const OPTIONS = [
  { label: "Yes, allow once", value: "proceed_once" },
  { label: "Yes, and always allow low", value: "proceed_always" },
  { label: "No, cancel", value: "cancel" },
];
const execReq = (id: string, cmd = "echo hi > out.txt") => ({
  type: "request" as const, id, method: "request_permission",
  params: { requestId: id, options: OPTIONS, toolUses: [{ toolUse: { type: "tool_use", id: "u1", name: "Execute", input: { command: cmd } }, confirmationType: "exec", details: { fullCommand: cmd, impactLevel: "medium", riskLevelReason: "writes a file" } }] },
});

describe("permission panel", () => {
  test("a command request shows the command, risk and reason, with numbered options", () => {
    const d = ev(driver(), execReq("r1"));
    const p = d.s.panels[0];
    expect(p.title).toBe("Command to approve");
    expect(p.body.join("\n")).toContain("echo hi > out.txt");
    expect(p.body.join("\n")).toContain("medium risk");
    expect(p.body.join("\n")).toContain("Why this needs approval:");
    expect(p.options.map((o) => o.label)).toEqual(OPTIONS.map((o) => o.label));
  });

  test("Enter selects the highlighted option; arrows move; wraps around", () => {
    let d = ev(driver(), execReq("r1"));
    d = key(d, "up"); // wraps to the last option
    expect(d.s.panels[0].selected).toBe(2);
    d = key(d, "down");
    d = key(d, "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "r1", method: "request_permission", result: { selectedOption: "proceed_once" } }]);
    expect(d.s.panels).toEqual([]);
  });

  test("number keys quick-select", () => {
    let d = ev(driver(), execReq("r1"));
    d = key(d, "char", "2");
    expect(d.effects[0]).toMatchObject({ result: { selectedOption: "proceed_always" } });
  });

  test("Esc cancels", () => {
    let d = ev(driver(), execReq("r1"));
    d = key(d, "esc");
    expect(d.effects[0]).toMatchObject({ requestId: "r1", result: { selectedOption: "cancel" } });
  });

  test("queued approvals are answered one at a time", () => {
    let d = ev(ev(driver(), execReq("r1")), execReq("r2", "rm -rf build"));
    expect(d.s.panels.length).toBe(2);
    d = key(d, "char", "1");
    expect(d.s.panels[0].action).toMatchObject({ requestId: "r2" });
    d = key(d, "char", "3");
    expect(d.effects.map((e: any) => e.requestId)).toEqual(["r1", "r2"]);
  });

  test("the panel takes keys: typing does not reach the input", () => {
    let d = ev(driver(), execReq("r1"));
    d = type(d, "x");
    expect(d.s.input.text).toBe("");
  });

  test("permission_resolved or the end of the turn removes a stale panel and cancels the pending answer", () => {
    let d = ev(driver(), execReq("r1"));
    d = note(d, { type: "permission_resolved", requestId: "r1", toolUseIds: ["u1"], selectedOption: "cancel" });
    expect(d.s.panels).toEqual([]);
    d = ev(driver(), execReq("r2"));
    d = note(d, { type: "agent_turn_completed", reason: "cancelled" });
    expect(d.s.panels).toEqual([]);
    expect(d.effects.find((e) => e.type === "answer")).toMatchObject({ requestId: "r2", result: { selectedOption: "cancel" } });
  });

  test("edit requests show a diff with added and removed lines", () => {
    const d = ev(driver(), {
      type: "request", id: "e1", method: "request_permission",
      params: { options: OPTIONS, toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "Edit", input: {} }, confirmationType: "edit", details: { filePath: "/p/a.ts", fileName: "a.ts", oldContent: "one\ntwo\nthree", newContent: "one\n2\nthree" } }] },
    });
    expect(d.s.panels[0].title).toBe("Edit a.ts");
    expect(d.s.panels[0].body).toContain("- two");
    expect(d.s.panels[0].body).toContain("+ 2");
  });

  test("a batch groups operations and relabels the options", () => {
    const use = (type: string, details: any) => ({ toolUse: { type: "tool_use", id: type, name: type, input: {} }, confirmationType: type, details });
    const d = ev(driver(), {
      type: "request", id: "b1", method: "request_permission",
      params: { options: OPTIONS, toolUses: [use("edit", { filePath: "a.ts", oldContent: "a", newContent: "b" }), use("create", { filePath: "n.ts", content: "x" }), use("exec", { fullCommand: "ls" })] },
    });
    const p = d.s.panels[0];
    expect(p.kind).toBe("batch");
    expect(p.title).toBe("Approve 3 operations:");
    expect(p.body.filter((l) => !l.startsWith(" "))).toEqual(["File Edits", "File Creations", "Commands"]);
    expect(p.options[0].label).toBe("Yes, allow all");
    expect(p.options[2].label).toBe("No, cancel all");
  });

  test("exit_spec_mode renders the plan and where it will be saved", () => {
    const d = ev(driver(), {
      type: "request", id: "x1", method: "request_permission",
      params: { options: OPTIONS, toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "ExitSpecMode", input: {} }, confirmationType: "exit_spec_mode", details: { plan: "# Plan\n1. do it", filePath: "/p/.rigwell/specs/a.md" } }] },
    });
    expect(d.s.panels[0]).toMatchObject({ kind: "exit_spec", title: "Specification for approval", savePath: "/p/.rigwell/specs/a.md" });
    expect(d.s.panels[0].body).toEqual(["# Plan", "1. do it"]);
  });
});

describe("ask_user panel", () => {
  const ask = {
    type: "request" as const, id: "a1", method: "ask_user",
    params: { toolCallId: "a1", questions: [
      { index: 1, topic: "db", question: "Which database?", options: ["sqlite", "postgres"] },
      { index: 2, topic: "extras", question: "Which extras?", options: ["auth", "logs", "metrics"], multiSelect: true },
    ] },
  };

  test("one question at a time; single then multi select; answers are returned together", () => {
    let d = ev(driver(), ask);
    expect(d.s.panels[0].title).toBe("[db] Which database?");
    d = key(d, "down");
    d = key(d, "enter");
    expect(d.s.panels[0].title).toBe("[extras] Which extras?");
    expect(d.s.panels[0].multi).toBe(true);
    d = key(d, "char", " ");
    d = key(d, "down");
    d = key(d, "down");
    d = key(d, "char", " ");
    d = key(d, "enter");
    expect(d.effects).toEqual([{
      type: "answer", requestId: "a1", method: "ask_user",
      result: { answers: [{ index: 1, question: "Which database?", answer: "postgres" }, { index: 2, question: "Which extras?", answer: "auth, metrics" }] },
    }]);
  });

  test("Esc cancels the request and stops the agent", () => {
    let d = ev(driver(), ask);
    d = key(d, "esc");
    expect(d.effects).toEqual([
      { type: "answer", requestId: "a1", method: "ask_user", result: { cancelled: true, answers: [] } },
      { type: "interrupt" },
    ]);
  });

  test("a question with no options defaults to Yes/No", () => {
    const d = ev(driver(), { ...ask, params: { toolCallId: "a2", questions: [{ index: 1, question: "Proceed?", options: [] }] } });
    expect(d.s.panels[0].options.map((o) => o.label)).toEqual(["Yes", "No", "Other..."]);
  });
});

describe("pick_options panel", () => {
  test("multi pick returns selected ids; preselected rows start checked", () => {
    let d = ev(driver(), {
      type: "request", id: "p1", method: "pick_options",
      params: { toolCallId: "p1", title: "Pick files", multi: true, preselectedIds: ["b"], rows: [{ id: "a", label: "A" }, { id: "b", label: "B", detail: "d" }, { id: "c", label: "C" }] },
    });
    expect(d.s.panels[0].checked).toEqual([1]);
    d = key(d, "char", "3");
    d = key(d, "enter");
    expect(d.effects[0]).toMatchObject({ method: "pick_options", result: { selectedIds: ["b", "c"] } });
  });
});

describe("trust panel (rigwell.request_trust)", () => {
  const trust = { type: "request" as const, id: "req-1", method: "request_trust", params: { cwd: "/work/proj", unlocks: ["project settings", "hooks"] } };

  test("shows the folder and what trust unlocks; defaults to not trusting", () => {
    const d = ev(driver(), trust);
    expect(d.s.panels[0]).toMatchObject({ kind: "trust", title: "Do you trust this folder?", selected: 1 });
    expect(d.s.panels[0].body.join("\n")).toContain("/work/proj");
    expect(d.s.panels[0].body.join("\n")).toContain("hooks");
    expect(d.s.panels[0].options.map((o) => o.label)).toEqual(["Yes, trust this folder", "No, don't trust it"]);
  });

  test("choosing yes answers {trust: true}; Enter on the default and Esc answer {trust: false} (no interrupt)", () => {
    let d = key(ev(driver(), trust), "char", "1");
    expect(d.effects).toEqual([{ type: "answer", requestId: "req-1", method: "request_trust", result: { trust: true } }]);
    expect(d.s.panels.length).toBe(0);
    d = key(ev(driver(), trust), "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "req-1", method: "request_trust", result: { trust: false } }]);
    d = key(ev(driver(), trust), "esc");
    expect(d.effects).toEqual([{ type: "answer", requestId: "req-1", method: "request_trust", result: { trust: false } }]);
  });
});

describe("prompts re-shown after load_session", () => {
  const ready = {
    type: "session_ready" as const, fresh: true,
    result: {
      sessionId: "s1", isAgentLoopInProgress: true, workingState: "waiting_for_tool_confirmation",
      pendingPermissions: [execReq("p1").params],
      pendingAskUserRequests: [{ requestId: "q1", toolCallId: "t", questions: [{ index: 1, topic: "db", question: "Which?", options: ["a", "b"] }] }],
    },
  };

  test("pending permissions and questions become panels, in order, and the session counts as running", () => {
    const d = ev(driver(), ready);
    expect(d.s.panels.map((p) => [p.kind, (p.action as any).requestId])).toEqual([["permission", "p1"], ["ask_user", "q1"]]);
    expect(d.s.running).toBe(true);
    expect(d.s.working).toBe("waiting_for_tool_confirmation");
  });

  test("answering a re-shown prompt yields the usual answer effect (the app sends it with answer_request)", () => {
    let d = ev(driver(), ready);
    d = key(d, "enter");
    expect(d.effects.filter((e) => e.type === "answer")).toEqual([{ type: "answer", requestId: "p1", method: "request_permission", result: { selectedOption: "proceed_once" } }]);
    d = key({ ...d, effects: [] }, "char", "2");
    expect(d.effects).toEqual([{ type: "answer", requestId: "q1", method: "ask_user", result: { answers: [{ index: 1, question: "Which?", answer: "b" }] } }]);
  });

  test("nothing pending: an idle session as before", () => {
    const d = ev(driver(), { type: "session_ready", fresh: true, result: { sessionId: "s2" } });
    expect(d.s.panels).toEqual([]);
    expect(d.s.running).toBe(false);
  });
});
