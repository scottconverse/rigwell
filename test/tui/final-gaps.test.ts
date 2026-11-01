import { describe, expect, test } from "bun:test";
import { driver, ev, key, note, type } from "./helpers.ts";
import { parseKeys } from "../../src/tui/keys.ts";
import { render, stripAnsi } from "../../src/tui/render.ts";
import { readClipboardImage, sniffImage } from "../../src/tui/clipboard.ts";

const OPTIONS = [
  { label: "Yes, proceed", value: "proceed_once" },
  { label: "Edit the spec first", value: "proceed_edit" },
  { label: "No, keep iterating", value: "cancel" },
];
const specReq = {
  type: "request" as const, id: "x1", method: "request_permission",
  params: { options: OPTIONS, toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "ExitSpecMode", input: {} }, confirmationType: "exit_spec_mode", details: { plan: "# Plan\n1. do it", filePath: "/p/a.md" } }] },
};
const execReq = {
  type: "request" as const, id: "r1", method: "request_permission",
  params: { options: [{ label: "Yes", value: "proceed_once" }, { label: "No", value: "cancel" }], toolUses: [{ toolUse: { type: "tool_use", id: "u1", name: "Execute", input: {} }, confirmationType: "exec", details: { fullCommand: "rm -rf x" } }] },
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("keys: Ctrl+Shift+C and Ctrl+V", () => {
  test("kitty and modifyOtherKeys encodings of Ctrl+Shift+C parse to ctrl+shift+c; plain Ctrl+C is unchanged", () => {
    expect(parseKeys("\x1b[99;6u")).toEqual([{ name: "ctrl+shift+c" }]);
    expect(parseKeys("\x1b[27;6;67~")).toEqual([{ name: "ctrl+shift+c" }]);
    expect(parseKeys("\x1b[99;5u")).toEqual([{ name: "ctrl+c" }]);
    expect(parseKeys("\x03")).toEqual([{ name: "ctrl+c" }]);
    expect(parseKeys("\x16")).toEqual([{ name: "ctrl+v" }]);
  });

  test("Ctrl+Shift+C copies the input and keeps it", () => {
    let d = type(driver(), "hello world");
    d = key(d, "ctrl+shift+c");
    expect(d.effects).toEqual([{ type: "copy", text: "hello world" }]);
    expect(d.s.input.text).toBe("hello world");
    const e = key(driver(), "ctrl+shift+c");
    expect(e.effects).toEqual([]);
    expect(e.s.hint).toBe("The input is empty");
  });

  test("Ctrl+V asks the app for a clipboard image; the image goes with the next message only", () => {
    let d = key(driver(), "ctrl+v");
    expect(d.effects).toEqual([{ type: "paste_image" }]);
    d = ev(d, { type: "image_pasted", image: { mediaType: "image/png", data: "AAAA" } });
    expect(d.s.images).toHaveLength(1);
    expect(stripAnsi(render(d.s, { width: 80, height: 24, color: false }).lines.join("\n"))).toContain("[Image #1]");
    d = type(d, "what is this");
    d = key(d, "enter");
    const send = d.effects.find((x) => x.type === "send") as any;
    expect(send.images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    expect(d.s.images).toEqual([]);
    d = note(d, { type: "agent_turn_completed", reason: "end_turn" });
    d = type(d, "next");
    d = key(d, "enter");
    expect((d.effects.filter((x) => x.type === "send").at(-1) as any).images).toBeUndefined();
  });

  test("the clipboard reader sniffs the image type and falls back through the tools", async () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from("hello world, not an image"))).toBeUndefined();
    const calls: string[] = [];
    const img = await readClipboardImage((cmd) => { calls.push(cmd); return cmd === "xclip" ? PNG : undefined; }, "linux");
    expect(calls).toEqual(["wl-paste", "xclip"]);
    expect(img).toEqual({ mediaType: "image/png", data: PNG.toString("base64") });
    expect(await readClipboardImage(() => undefined, "linux")).toBeUndefined();
  });
});

describe("SANDBOX marker", () => {
  test("shown while settings.sandbox.active is true, from session_ready and settings_updated", () => {
    let d = ev(driver(), { type: "session_ready", fresh: true, result: { sessionId: "s", settings: { sandbox: { active: true } } } });
    expect(d.s.sandbox).toBe(true);
    const status = (x: typeof d) => stripAnsi(render(x.s, { width: 100, height: 24, color: false }).lines.at(-2)!);
    expect(status(d)).toContain("SANDBOX");
    d = note(d, { type: "settings_updated", settings: { sandbox: { active: false } } });
    expect(d.s.sandbox).toBe(false);
    expect(status(d)).not.toContain("SANDBOX");
    d = note(d, { type: "settings_updated", settings: { modelId: "m2" } });
    expect(d.s.sandbox).toBe(false);
  });
});

describe("spec panel: comment and Ctrl+G edit", () => {
  test("Tab opens the comment box; Enter sends the chosen option with the comment", () => {
    let d = ev(driver(), specReq);
    d = key(d, "tab");
    expect(d.s.panels[0].commentMode).toBe(true);
    for (const c of "use sqlite") d = type(d, c);
    d = key(d, "backspace");
    d = key(d, "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "x1", method: "request_permission", result: { selectedOption: "proceed_once", comment: "use sqlit" } }]);
    expect(d.s.panels).toEqual([]);
  });

  test("Esc in the comment box goes back to the options; Esc again cancels with the comment", () => {
    let d = ev(driver(), specReq);
    d = key(d, "tab");
    d = type(d, "not yet");
    d = key(d, "esc");
    expect(d.s.panels[0].commentMode).toBe(false);
    expect(d.effects).toEqual([]);
    d = key(d, "esc");
    expect(d.effects).toEqual([{ type: "answer", requestId: "x1", method: "request_permission", result: { selectedOption: "cancel", comment: "not yet" } }]);
  });

  test("Ctrl+G opens the plan in the editor; the edit comes back as editedSpecContent with proceed_edit", () => {
    let d = ev(driver(), specReq);
    d = key(d, "ctrl+g");
    expect(d.effects).toEqual([{ type: "editor", text: "# Plan\n1. do it", target: "spec" }]);
    d = ev({ ...d, effects: [] }, { type: "spec_edited", text: "# Plan\n1. do it better" });
    expect(d.s.panels[0].editedSpec).toBe("# Plan\n1. do it better");
    expect(d.s.panels[0].options[d.s.panels[0].selected].value).toBe("proceed_edit");
    d = key(d, "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "x1", method: "request_permission", result: { selectedOption: "proceed_edit", editedSpecContent: "# Plan\n1. do it better" } }]);
  });

  test("choosing 'Edit the spec first' before editing opens the editor instead of answering", () => {
    let d = ev(driver(), specReq);
    d = key(d, "char", "2");
    expect(d.effects).toEqual([{ type: "editor", text: "# Plan\n1. do it", target: "spec" }]);
    expect(d.s.panels).toHaveLength(1);
  });

  test("an edit with a comment sends both; an empty edit is ignored", () => {
    let d = ev(driver(), specReq);
    d = ev(d, { type: "spec_edited", text: "   " });
    expect(d.s.panels[0].editedSpec).toBeUndefined();
    d = ev(d, { type: "spec_edited", text: "# New" });
    d = key(d, "tab");
    d = type(d, "go");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toMatchObject({ result: { selectedOption: "proceed_edit", editedSpecContent: "# New", comment: "go" } });
  });
});

describe("denial comments", () => {
  test("a permission denial carries the comment", () => {
    let d = ev(driver(), execReq);
    d = key(d, "tab");
    for (const c of "use a dry run") d = type(d, c);
    d = key(d, "down");
    d = key(d, "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "r1", method: "request_permission", result: { selectedOption: "cancel", comment: "use a dry run" } }]);
  });

  test("without a comment the answer is unchanged", () => {
    let d = ev(driver(), execReq);
    d = key(d, "char", "2");
    expect(d.effects).toEqual([{ type: "answer", requestId: "r1", method: "request_permission", result: { selectedOption: "cancel" } }]);
  });

  test("digits typed in the comment box are text, not quick-select", () => {
    let d = ev(driver(), execReq);
    d = key(d, "tab");
    d = type(d, "2");
    expect(d.s.panels[0].comment).toBe("2");
    expect(d.effects).toEqual([]);
  });
});

describe("ask_user: Other... free text", () => {
  const ask = (multi = false) => ({
    type: "request" as const, id: "a1", method: "ask_user",
    params: { toolCallId: "a1", questions: [{ index: 1, question: "Which database?", options: ["sqlite", "postgres"], multiSelect: multi }] },
  });

  test("every question ends with an Other... option", () => {
    const d = ev(driver(), ask());
    expect(d.s.panels[0].options.map((o) => o.label)).toEqual(["sqlite", "postgres", "Other..."]);
  });

  test("Other... opens a text box; Enter sends what was typed as the answer", () => {
    let d = ev(driver(), ask());
    d = key(d, "char", "3");
    expect(d.s.panels[0].other).toEqual({ typing: true, text: "" });
    expect(d.effects).toEqual([]);
    d = key(d, "enter"); // empty text: stays open
    expect(d.s.panels).toHaveLength(1);
    for (const c of "duckdb") d = type(d, c);
    d = key(d, "enter");
    expect(d.effects).toEqual([{ type: "answer", requestId: "a1", method: "ask_user", result: { answers: [{ index: 1, question: "Which database?", answer: "duckdb" }] } }]);
  });

  test("Esc in the text box returns to the options without cancelling", () => {
    let d = ev(driver(), ask());
    d = key(d, "char", "3");
    d = type(d, "x");
    d = key(d, "esc");
    expect(d.s.panels[0].other).toBeUndefined();
    expect(d.effects).toEqual([]);
    d = key(d, "enter");
    expect(d.effects[0]).toMatchObject({ result: { answers: [{ answer: "sqlite" }] } });
  });

  test("multi-select: ticked options and the typed text are joined", () => {
    let d = ev(driver(), ask(true));
    d = key(d, "char", " ");
    d = key(d, "up"); // wraps to Other...
    d = key(d, "char", " ");
    d = key(d, "enter");
    expect(d.s.panels[0].other?.typing).toBe(true);
    for (const c of "mysql") d = type(d, c);
    d = key(d, "enter");
    expect(d.effects[0]).toMatchObject({ result: { answers: [{ answer: "sqlite, mysql" }] } });
  });

  test("the panel shows the typed text", () => {
    let d = ev(driver(), ask());
    d = key(d, "char", "3");
    d = type(d, "duck");
    expect(stripAnsi(render(d.s, { width: 80, height: 30, color: false }).lines.join("\n"))).toContain("Your answer: duck_");
  });
});
