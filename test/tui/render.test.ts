import { describe, expect, test } from "bun:test";
import { parseKeys } from "../../src/tui/keys.ts";
import { render, stripAnsi, wrapText } from "../../src/tui/render.ts";
import { driver, ev, key, note, type } from "./helpers.ts";

const plain = (d: ReturnType<typeof driver>, w = 80, h = 24) => render(d.s, { width: w, height: h, color: false });

describe("render", () => {
  test("fills exactly height lines of at most width characters", () => {
    let d = key(type(driver(), "hello there"), "enter");
    d = note(d, { type: "assistant_text_delta", messageId: "a", blockIndex: 0, textDelta: "x".repeat(300) });
    for (const [w, h] of [[80, 24], [40, 10], [120, 40]]) {
      const scr = plain(d, w, h);
      expect(scr.lines.length).toBe(h);
      expect(scr.lines.every((l) => stripAnsi(l).length <= w)).toBe(true);
    }
  });

  test("layout top to bottom: header, transcript, input, status bar, footer (spec 13.1)", () => {
    let d = driver({ header: { agentsMd: true, skills: 0, mcps: 0, issues: 0 }, autonomy: "medium", reasoning: "high" });
    d = key(type(d, "do the thing"), "enter");
    d = note(d, { type: "assistant_text_delta", messageId: "a", blockIndex: 0, textDelta: "Working on it" });
    const lines = plain(d).lines;
    const idx = (s: string) => lines.findIndex((l) => l.includes(s));
    expect(idx("Rigwell")).toBeGreaterThanOrEqual(0);
    expect(lines[1]).toContain("/work/proj");
    expect(lines.join("\n")).toContain("AGENTS.md: Loaded");
    expect(idx("> do the thing")).toBeGreaterThan(idx("Rigwell"));
    expect(idx("Working on it")).toBeGreaterThan(idx("> do the thing"));
    expect(idx("Enter to steer")).toBeGreaterThan(idx("Working on it"));
    expect(idx("Auto (Med) · allow reversible commands")).toBeGreaterThan(idx("Enter to steer"));
    expect(lines.at(-1)).toContain("? for help");
    expect(lines.at(-2)).toContain("Model One");
    expect(lines.at(-2)).toContain("context: n/a");
  });

  test("status bar shows the context percent, the timer while running and markers", () => {
    let d = driver({ contextLimit: 200_000, contextUsed: 100_000, autoCompress: false, shellMode: true, running: true, runStartedAt: 1000, now: 13_500 });
    const bar = plain(d, 140).lines.at(-2)!;
    expect(bar).toContain("context: 50%");
    expect(bar).toContain("12s");
    expect(bar).toContain("auto-compress off");
    expect(bar).toContain("Bash mode active • Esc to exit");
  });

  test("placeholder follows the mode; spec mode says research and plan first", () => {
    expect(plain(driver()).lines.join("\n")).toContain("Type a message");
    expect(plain(driver({ mode: "spec" })).lines.join("\n")).toContain("research and plan first");
    expect(plain(driver({ mode: "spec" })).lines.at(-2)).toContain("Spec");
    expect(plain(driver({ running: true })).lines.join("\n")).toContain("Enter to steer · Ctrl+Enter to queue");
  });

  test("tool blocks are collapsed until Ctrl+O", () => {
    let d = driver();
    d = note(d, { type: "tool_call", toolUse: { type: "tool_use", id: "u", name: "Read", input: { path: "src/a.ts" } } });
    d = note(d, { type: "tool_result", toolUseId: "u", content: "line1\nline2", isError: false });
    let text = plain(d).lines.join("\n");
    expect(text).toContain("▸ Read src/a.ts");
    expect(text).toContain("✓");
    expect(text).not.toContain("line2");
    d = key(d, "ctrl+o");
    text = plain(d).lines.join("\n");
    expect(text).toContain("line2");
    expect(text).toContain('"path": "src/a.ts"');
  });

  test("pending messages are listed above the prompt", () => {
    let d = key(type(driver(), "go"), "enter");
    d = key(type(d, "steer me"), "enter");
    d = key(type(d, "later"), "ctrl+enter");
    const text = plain(d).lines.join("\n");
    expect(text).toContain("Steering messages:");
    expect(text).toContain("Queued messages:");
    expect(text).toContain("Ctrl+R review");
  });

  test("the slash menu lists matching commands under the input", () => {
    const text = plain(type(driver(), "/th")).lines.join("\n");
    expect(text).toContain("▶ /themes");
  });

  test("a permission panel replaces the input box and shows 'Approval i of n'", () => {
    const req = (id: string) => ({
      type: "request" as const, id, method: "request_permission",
      params: { options: [{ label: "Yes, allow once", value: "proceed_once" }, { label: "No, cancel", value: "cancel" }], toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "Execute", input: {} }, confirmationType: "exec", details: { fullCommand: "make test", impactLevel: "low", riskLevelReason: "runs tests" } }] },
    });
    const d = ev(ev(driver(), req("r1")), req("r2"));
    const text = plain(d).lines.join("\n");
    expect(text).toContain("Approval 1 of 2");
    expect(text).toContain("Command to approve");
    expect(text).toContain("make test");
    expect(text).toContain("› 1. Yes, allow once");
    expect(text).toContain("  2. No, cancel");
    expect(text).not.toContain("Type a message");
  });

  test("long diffs fold with a Ctrl+O note", () => {
    const old = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
    const d = ev(driver(), {
      type: "request", id: "e", method: "request_permission",
      params: { options: [{ label: "Yes", value: "proceed_once" }], toolUses: [{ toolUse: { type: "tool_use", id: "u", name: "Create", input: {} }, confirmationType: "create", details: { fileName: "big.txt", content: old } }] },
    });
    const folded = plain(d, 80, 40).lines.join("\n");
    expect(folded).toContain("Create big.txt");
    expect(folded).toMatch(/\.\.\. \d+ more lines \(Ctrl\+O to expand\)/);
  });

  test("overlays replace the transcript", () => {
    let d = type(driver(), "/status");
    d = key(d, "enter");
    const text = plain(d).lines.join("\n");
    expect(text).toContain("Status");
    expect(text).toContain("Data folder:");
    expect(text).not.toContain("Skills: Not found");
  });

  test("the cursor lands in the input box", () => {
    let d = type(driver(), "abc");
    const scr = plain(d);
    const row = scr.lines.findIndex((l) => l.startsWith("> abc"));
    expect(scr.cursor).toEqual({ row, col: 5 });
    d = type(d, "\n");
    expect(plain(d).cursor).not.toBeNull();
  });

  test("color mode adds ANSI; plain mode has none", () => {
    expect(render(driver().s, { width: 80, height: 24, color: true }).lines.join("").includes("\x1b[")).toBe(true);
    expect(plain(driver()).lines.join("").includes("\x1b[")).toBe(false);
  });

  test("wrapText wraps on spaces and hard-cuts long words", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("parseKeys", () => {
  test("printable text, Enter, backspace and Ctrl keys", () => {
    expect(parseKeys("hi\r")).toEqual([{ name: "char", text: "hi" }, { name: "enter" }]);
    expect(parseKeys("\x7f\t\x03\x0f")).toEqual([{ name: "backspace" }, { name: "tab" }, { name: "ctrl+c" }, { name: "ctrl+o" }]);
    expect(parseKeys("\r\n")).toEqual([{ name: "enter" }]);
  });
  test("arrows, Shift+Tab, Delete, Alt combinations", () => {
    expect(parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[Z\x1b[3~")).toEqual([{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }, { name: "shift+tab" }, { name: "delete" }]);
    expect(parseKeys("\x1b[1;3A\x1bx\x1bp")).toEqual([{ name: "alt+up" }, { name: "alt+x" }, { name: "alt+p" }]);
  });
  test("a lone Esc and Ctrl+Enter variants", () => {
    expect(parseKeys("\x1b")).toEqual([{ name: "esc" }]);
    expect(parseKeys("\x1b[13;5u")).toEqual([{ name: "ctrl+enter" }]);
    expect(parseKeys("\x1b[27;5;13~")).toEqual([{ name: "ctrl+enter" }]);
    expect(parseKeys("\x1b\r")).toEqual([{ name: "alt+enter" }]);
  });
  test("bracketed paste arrives as one paste key with newlines kept", () => {
    expect(parseKeys("\x1b[200~line1\nline2\x1b[201~")).toEqual([{ name: "paste", text: "line1\nline2" }]);
  });
});
