import { describe, expect, test } from "bun:test";
import { contextPercent, slashMenu } from "../../src/tui/reducer.ts";
import { driver, ev, key, note, take, type } from "./helpers.ts";

describe("sending and steering", () => {
  test("Enter sends a message and marks the run active", () => {
    let d = driver();
    d = key(type(d, "hello"), "enter");
    expect(d.effects).toEqual([{ type: "send", text: "hello", messageId: "t-1" }]);
    expect(d.s.running).toBe(true);
    expect(d.s.items).toEqual([{ kind: "user", text: "hello", id: "t-1" }]);
    expect(d.s.input.text).toBe("");
  });

  test("while running Enter steers at once with end_of_loop; Ctrl+Enter queues on the client until the turn ends", () => {
    let d = key(type(driver(), "first"), "enter");
    d = key(type(d, "queued one"), "ctrl+enter");
    d = key(type(d, "steer one"), "enter");
    expect(d.s.pending).toEqual({ steer: ["steer one"], queue: ["queued one"] });
    const sent = d.effects.filter((e) => e.type === "send") as any[];
    expect(sent.map((e) => [e.text, e.queuePlacement])).toEqual([["first", undefined], ["steer one", "end_of_loop"]]);
    // The next tool result means the harness delivered the steer message: it joins the transcript.
    d = note(d, { type: "tool_result", toolUseId: "u1", content: "ok", isError: false });
    expect(d.s.pending.steer).toEqual([]);
    expect(d.s.items.at(-1)).toEqual({ kind: "user", text: "steer one" });
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    expect(d.effects.filter((e) => e.type === "send").map((e: any) => e.text)).toEqual(["first", "steer one", "queued one"]);
    expect(d.s.pending).toEqual({ steer: [], queue: [] });
  });

  test("an undelivered steer message is shown when the turn ends and holds the queue back", () => {
    let d = key(type(driver(), "first"), "enter");
    d = key(type(d, "queued one"), "ctrl+enter");
    d = key(type(d, "steer one"), "enter");
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    expect(d.s.items.at(-1)).toEqual({ kind: "user", text: "steer one" });
    expect(d.s.running).toBe(true);
    expect(d.s.pending).toEqual({ steer: [], queue: ["queued one"] });
    expect(d.effects.filter((e) => e.type === "send").length).toBe(2);
  });

  test("Ctrl+G pulls the top pending item back, Ctrl+X clears, Ctrl+R lists", () => {
    let d = key(type(driver(), "go"), "enter");
    d = key(type(d, "a"), "enter");
    d = key(type(d, "b"), "ctrl+enter");
    d = key(d, "ctrl+r");
    expect(d.s.overlay?.lines.map((l) => l.replace(/\(.*?\)/, "").replace(/\s+/g, " "))).toEqual(["steer : a", "queued : b"]);
    d = key(d, "esc");
    d = key(d, "ctrl+g"); // only queued messages can be pulled back; the steer message is already with the harness
    expect(d.s.input.text).toBe("b");
    expect(d.s.pending).toEqual({ steer: ["a"], queue: [] });
    d = key(type(d, "c"), "ctrl+enter");
    d = key(d, "ctrl+x");
    expect(d.s.pending.queue).toEqual([]);
  });

  test("an interrupted turn keeps pending messages and sends nothing", () => {
    let d = key(type(driver(), "go"), "enter");
    d = key(type(d, "later"), "ctrl+enter");
    d = key(d, "esc");
    expect(d.effects.at(-1)).toEqual({ type: "interrupt" });
    d = note(d, { type: "agent_turn_completed", reason: "cancelled" });
    expect(d.effects.filter((e) => e.type === "send").length).toBe(1);
    expect(d.s.pending.queue).toEqual(["later"]);
    expect(d.s.running).toBe(false);
  });

  test("backslash then Enter inserts a newline", () => {
    let d = type(driver(), "line one\\");
    d = key(d, "enter");
    d = type(d, "line two");
    expect(d.s.input.text).toBe("line one\nline two");
    expect(d.effects).toEqual([]);
  });
});

describe("input editing and history", () => {
  test("cursor movement and deletion", () => {
    let d = type(driver(), "abcd");
    d = key(key(d, "left"), "left");
    d = type(d, "X");
    expect(d.s.input).toEqual({ text: "abXcd", cursor: 3 });
    d = key(d, "backspace");
    expect(d.s.input.text).toBe("abcd");
    d = key(d, "ctrl+u");
    expect(d.s.input.text).toBe("cd");
    d = key(d, "ctrl+e");
    d = key(d, "ctrl+w");
    expect(d.s.input.text).toBe("");
  });

  test("Up/Down walk the history and restore the draft", () => {
    let d = driver();
    d = key(type(d, "one"), "enter");
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    d = key(type(d, "two"), "enter");
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    d = type(d, "draft");
    d = key(d, "up");
    expect(d.s.input.text).toBe("two");
    d = key(d, "up");
    expect(d.s.input.text).toBe("one");
    d = key(d, "down");
    d = key(d, "down");
    expect(d.s.input.text).toBe("draft");
  });

  test("Up moves between lines before touching the history", () => {
    let d = driver({ history: ["old"] });
    d = type(d, "a\\");
    d = key(d, "enter");
    d = type(d, "b");
    d = key(d, "up");
    expect(d.s.input.text).toBe("a\nb");
    expect(d.s.input.cursor).toBe(1);
  });

  test("double Esc clears the input; Ctrl+C clears; Ctrl+C twice on empty quits", () => {
    let d = type(driver(), "oops");
    d = key(d, "esc");
    expect(d.s.input.text).toBe("oops");
    d = key(d, "esc");
    expect(d.s.input.text).toBe("");
    d = type(d, "again");
    d = key(d, "ctrl+c");
    expect(d.s.input.text).toBe("");
    d = key(d, "ctrl+c");
    d = key(d, "ctrl+c");
    expect(d.s.quit).toBe(true);
    expect(d.effects.at(-1)).toEqual({ type: "quit" });
  });
});

describe("slash commands and menus", () => {
  test("typing / opens the menu; Tab completes; Enter runs", () => {
    let d = type(driver(), "/co");
    expect(slashMenu(d.s).map((c) => c.name)).toEqual(["context", "cost", "compress", "copy", "commands"]);
    d = key(d, "tab");
    expect(d.s.input.text).toBe("/context ");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "fetch_context", show: true });
  });

  test("Enter on a partial name completes instead of running", () => {
    let d = type(driver(), "/qu");
    d = key(d, "enter");
    expect(d.s.input.text).toBe("/quit ");
    expect(d.s.quit).toBe(false);
    d = key(d, "enter");
    expect(d.s.quit).toBe(true);
  });

  test("aliases resolve; Esc closes the menu", () => {
    let d = type(driver(), "/exit");
    d = key(d, "enter");
    expect(d.s.quit).toBe(true);
    d = type(driver(), "/c");
    d = key(d, "esc");
    expect(slashMenu(d.s)).toEqual([]);
  });

  test("unknown commands report an error and send nothing", () => {
    let d = type(driver(), "/nope");
    d = key(d, "enter"); // completes? no match, so submits
    expect(d.s.items.at(-1)).toMatchObject({ kind: "info", level: "error" });
    expect(d.effects).toEqual([]);
  });

  test("/new while running asks to stop first", () => {
    let d = key(type(driver(), "go"), "enter");
    d = type(d, "/new");
    d = key(d, "enter");
    expect(d.s.panels[0].kind).toBe("confirm");
    expect(d.s.panels[0].title).toBe("Stop the current run?");
    const before = d.effects.length;
    d = key(d, "char", "1");
    expect(d.effects.slice(before)).toEqual([{ type: "interrupt" }, { type: "new_session" }]);
  });

  test("/new when idle starts a new session at once; /cwd needs an argument", () => {
    let d = type(driver(), "/clear");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "new_session" });
    d = type(d, "/cd /tmp");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "new_session", cwd: "/tmp" });
  });

  test("/model opens a picker that updates the session", () => {
    let d = type(driver(), "/model");
    d = key(d, "enter");
    expect(d.s.panels[0].options.map((o) => o.value)).toEqual(["m1", "m2"]);
    d = key(d, "down");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "settings", patch: { modelId: "m2" } });
    expect(d.s.panels.length).toBe(0);
  });

  test("/vim, /themes and /help", () => {
    let d = type(driver(), "/vim");
    d = key(d, "enter");
    expect(d.s.vim).toBe(true);
    d = type(d, "/themes light");
    d = key(d, "enter");
    expect(d.s.theme).toBe("light");
    d = key(d, "char", "?");
    expect(d.s.overlay?.title).toBe("Help");
    expect(d.s.overlay?.lines.join("\n")).toContain("Ctrl+L");
    d = key(d, "esc");
    expect(d.s.overlay).toBeNull();
  });

  test("! enters Bash mode, runs the command directly, Esc leaves", () => {
    let d = type(driver(), "!");
    expect(d.s.shellMode).toBe(true);
    expect(d.s.input.text).toBe("");
    d = key(d, "esc");
    expect(d.s.shellMode).toBe(false);
    d = type(type(d, "!"), "ls -la");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "shell", command: "ls -la" });
    expect(d.s.running).toBe(false);
  });

  test("@ asks for file matches and Tab inserts the pick", () => {
    let d = type(driver(), "look at @sr");
    expect(d.effects.at(-1)).toEqual({ type: "files", query: "sr" });
    d = ev(d, { type: "file_matches", query: "sr", items: ["src/", "srv.ts"] });
    expect(d.s.atMenu?.items.length).toBe(2);
    d = key(d, "down");
    d = key(d, "tab");
    expect(d.s.input.text).toBe("look at @srv.ts ");
    expect(d.s.atMenu).toBeNull();
  });

  test("stale file matches are ignored", () => {
    let d = type(driver(), "@a");
    d = ev(d, { type: "file_matches", query: "zzz", items: ["zzz"] });
    expect(d.s.atMenu).toBeNull();
  });
});

describe("keys that change settings", () => {
  test("Shift+Tab toggles spec mode, Ctrl+L cycles autonomy, Tab cycles reasoning, Ctrl+N cycles models", () => {
    let d = key(driver(), "shift+tab");
    expect(d.effects.at(-1)).toEqual({ type: "settings", patch: { interactionMode: "spec" } });
    d = key(d, "shift+tab");
    expect(d.s.mode).toBe("auto");
    d = key(d, "ctrl+l");
    expect(d.effects.at(-1)).toEqual({ type: "settings", patch: { autonomyLevel: "low" } });
    for (let i = 0; i < 3; i++) d = key(d, "ctrl+l");
    expect(d.s.autonomy).toBe("off");
    d = key(d, "tab");
    expect(d.effects.at(-1)).toEqual({ type: "settings", patch: { reasoningEffort: "off" } });
    d = key(d, "ctrl+n");
    expect(d.effects.at(-1)).toEqual({ type: "settings", patch: { modelId: "m2" } });
    d = key(d, "alt+x");
    expect(d.s.autoCompress).toBe(false);
    d = key(d, "ctrl+o");
    expect(d.s.detailed).toBe(true);
  });

  test("settings_updated notifications update the status fields", () => {
    const d = note(driver(), { type: "settings_updated", settings: { modelId: "m2", reasoningEffort: "low", interactionMode: "spec", autonomyLevel: "high" } });
    expect(d.s).toMatchObject({ modelId: "m2", reasoning: "low", mode: "spec", autonomy: "high" });
  });
});

describe("notifications build the transcript", () => {
  test("text deltas accumulate, tool_call replaces by id, results attach", () => {
    let d = driver();
    d = note(d, { type: "assistant_text_delta", messageId: "a1", blockIndex: 0, textDelta: "Hel" });
    d = note(d, { type: "assistant_text_delta", messageId: "a1", blockIndex: 0, textDelta: "lo" });
    d = note(d, { type: "tool_call", toolUse: { type: "tool_use", id: "u1", name: "Read", input: {} } });
    d = note(d, { type: "tool_call", toolUse: { type: "tool_use", id: "u1", name: "Read", input: { path: "a.ts" } } });
    d = note(d, { type: "tool_execution_phase_changed", toolUseId: "u1", toolName: "Read", phase: "executing" });
    d = note(d, { type: "tool_result", toolUseId: "u1", content: "file text", isError: false });
    expect(d.s.items).toEqual([
      { kind: "assistant", id: "a1:0", text: "Hello" },
      { kind: "tool", id: "u1", name: "Read", input: { path: "a.ts" }, status: "ok", phase: "executing", output: "file text" },
    ]);
  });

  test("errors and non-completed turns are shown; unknown notification types are ignored", () => {
    let d = note(driver(), { type: "something_new", x: 1 });
    expect(d.s.items).toEqual([]);
    d = note(d, { type: "error", message: "boom" });
    d = note(d, { type: "agent_turn_completed", reason: "model_rate_limited" });
    expect(d.s.items.map((i: any) => i.text)).toEqual(["boom", "Turn ended: model_rate_limited"]);
  });

  test("the context meter uses provider-reported input tokens over the limit", () => {
    let d = ev(driver(), { type: "context_stats", stats: { used: 0, limit: 200_000 }, show: false });
    expect(contextPercent(d.s)).toBe("0%");
    d = note(d, { type: "session_token_usage_changed", tokenUsage: { inputTokens: 500 }, lastCallTokenUsage: { inputTokens: 500, cacheReadTokens: 0, outputTokens: 5 } });
    expect(contextPercent(d.s)).toBe("<1%");
    d = note(d, { type: "session_token_usage_changed", lastCallTokenUsage: { inputTokens: 50_000, cacheReadTokens: 50_000 } });
    expect(contextPercent(d.s)).toBe("50%");
  });

  test("/context opens an overlay from get_context_stats", () => {
    let d = type(driver(), "/context");
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "fetch_context", show: true });
    d = ev(d, { type: "context_stats", stats: { used: 12340, limit: 200000, categories: [{ name: "System prompt", tokens: 10000 }, { name: "Messages", tokens: 2340 }] }, show: true });
    const text = d.s.overlay!.lines.join("\n");
    expect(text).toContain("Compaction meter 12,340/200,000 tokens (6%)");
    expect(text).toContain("Estimated usage by category");
    expect(text).toContain("System prompt");
    expect(text).toContain("Estimated Free Space");
  });
});

describe("restored sessions", () => {
  test("session_ready rebuilds the transcript from messages and resets run state", () => {
    const d = ev(driver(), {
      type: "session_ready", fresh: true,
      result: {
        sessionId: "s1", settings: { modelId: "m2", reasoningEffort: "low", interactionMode: "auto", autonomyLevel: "low" },
        availableModels: [{ id: "m2", displayName: "Two" }],
        session: { messages: [
          { id: "c", role: "user", visibility: "llm_only", content: [{ type: "text", text: "context" }] },
          { id: "u", role: "user", content: [{ type: "text", text: "fix it" }] },
          { id: "a", role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] },
          { id: "r", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ] },
      },
    });
    expect(d.s.sessionId).toBe("s1");
    expect(d.s.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect((d.s.items[2] as any).output).toBe("ok");
    expect(d.effects).toEqual([{ type: "fetch_context", show: false }]);
  });
});
