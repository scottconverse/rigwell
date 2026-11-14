// Gap-wave TUI features: custom commands, config views, rewind, scrolling, attention, status line, steering.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState } from "../../src/tui/reducer.ts";
import { focusAllows, makeWav, playSound, progressSequence, runStatusLine, scaleWav, soundSettings, statusLineConfig, findPlayer } from "../../src/tui/attention.ts";
import { BUILTIN_SKILLS } from "../../src/skills/index.ts";
import { expandEntry, loadCustomEntries, parseLoop } from "../../src/tui/customcmd.ts";
import { parseKeys } from "../../src/tui/keys.ts";
import { render, stripAnsi } from "../../src/tui/render.ts";
import { buildView, statusLineInput } from "../../src/tui/views.ts";
import { matchCommands } from "../../src/tui/commands.ts";
import { jsCommand, sleepCommand } from "../platform.ts";
import { driver, ev, key, note, rawEv, type } from "./helpers.ts";

let home: string, proj: string;
const oldHome = process.env.RIGWELL_HOME;
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "tui-gaps-"));
  home = join(root, "home");
  proj = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".git"), { recursive: true });
  process.env.RIGWELL_HOME = home;
  mkdirSync(join(proj, ".rigwell", "commands"), { recursive: true });
  mkdirSync(join(home, "commands"), { recursive: true });
  writeFileSync(join(proj, ".rigwell", "commands", "review.md"), "---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1 carefully. Extra: $ARGUMENTS\n");
  writeFileSync(join(home, "commands", "review.md"), "user version");
  writeFileSync(join(home, "commands", "plain.md"), "# Plain prompt\nDo the thing.");
  writeFileSync(join(home, "commands", "help.md"), "shadowed by built-in");
  mkdirSync(join(proj, ".rigwell", "skills", "tidy"), { recursive: true });
  writeFileSync(join(proj, ".rigwell", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidy things up\n---\nTidy body");
  mkdirSync(join(proj, ".rigwell", "agents"), { recursive: true });
  writeFileSync(join(proj, ".rigwell", "agents", "scout.md"), "---\nname: scout\ndescription: Looks around\n---\nYou scout.");
  writeFileSync(join(proj, ".rigwell", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "echo hi" }] }] },
    statusLine: { type: "command", command: "echo status-ok", maxRows: 2 },
  }));
});
afterAll(() => { if (oldHome === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = oldHome; rmSync(join(home, ".."), { recursive: true, force: true }); });

describe("custom commands and skills", () => {
  test("loads project and user commands plus skills; built-in names and duplicates are skipped", () => {
    const all = loadCustomEntries(proj, "/nonexistent-home");
    const entries = all.entries.filter((e) => e.origin !== "builtin");
    expect(entries.map((e) => `${e.kind}:${e.name}:${e.origin}`)).toEqual(["command:review:project", "command:plain:user", "skill:tidy:project-dir"]);
    // built-in skills are offered too, but the project command "review" wins over the built-in skill of that name
    expect(all.entries.filter((e) => e.origin === "builtin").map((e) => e.name)).not.toContain("review");
    expect(all.skills).toBe(1 + BUILTIN_SKILLS.length);
    expect(entries[0].desc).toBe("Review a file");
    expect(entries[0].argHint).toBe("<file>");
    expect(entries[1].desc).toBe("Plain prompt");
  });

  test("expansion substitutes $ARGUMENTS and $n, appends arguments when there is no placeholder", () => {
    const entries = loadCustomEntries(proj, "/nonexistent-home").entries.filter((e) => e.origin !== "builtin");
    expect(expandEntry(entries[0], "a.ts and more")).toBe("Review a.ts carefully. Extra: a.ts and more");
    expect(expandEntry(entries[1], "")).toBe("# Plain prompt\nDo the thing.");
    expect(expandEntry(entries[1], "now")).toBe("# Plain prompt\nDo the thing.\n\nnow");
    const skill = expandEntry(entries[2], "x");
    expect(skill).toContain('<skill name="tidy"');
    expect(skill).toContain("Arguments: x");
  });

  test("they appear in the / menu and running one sends the expanded prompt", () => {
    const { entries, skills } = loadCustomEntries(proj, "/nonexistent-home");
    const nSkills = skills;
    let d = driver();
    d = ev(d, { type: "extras", custom: entries, skills, mcps: 2, issues: 1 });
    expect(d.s.header).toMatchObject({ skills: nSkills, mcps: 2, issues: 1 });
    expect(matchCommands("re", d.s.custom).map((c) => c.name)).toContain("review");
    d = type(d, "/rev");
    expect(stripAnsi(render(d.s, { width: 80, height: 30, color: false }).lines.join("\n"))).toContain("/review <file>  Review a file");
    d = key(d, "tab");
    d = type(d, "x.ts");
    d = key(d, "enter");
    const send = d.effects.find((e) => e.type === "send") as any;
    expect(send.text).toBe("Review x.ts carefully. Extra: x.ts");
    expect(d.s.items.at(-1)).toMatchObject({ kind: "user", text: "/review x.ts" });
    expect(d.s.running).toBe(true);
  });
});

describe("loop parsing", () => {
  test("forms from the spec", () => {
    expect(parseLoop("30m check the build")).toEqual({ kind: "create", interval: "30m", prompt: "check the build" });
    expect(parseLoop("check the build every 2h")).toEqual({ kind: "create", interval: "2h", prompt: "check the build" });
    expect(parseLoop("5m")).toEqual({ kind: "create", interval: "5m", prompt: "" });
    expect(parseLoop("list")).toEqual({ kind: "list" });
    expect(parseLoop("stop")).toEqual({ kind: "stop", id: "all" });
    expect(parseLoop("stop ab12")).toEqual({ kind: "stop", id: "ab12" });
    expect(parseLoop("whatever").kind).toBe("error");
  });
});

describe("view effects", () => {
  test.each(["mcp", "hooks", "skills", "commands", "agents", "diagnostics", "statusline", "automations", "loop"])("/%s asks the app for a view", (name) => {
    const d = key(type(driver(), `/${name} some args`), "enter");
    expect(d.effects).toEqual([{ type: "view", name: name as any, args: "some args" }]);
  });

  test("an overlay event shows the lines", () => {
    const d = ev(driver(), { type: "overlay", title: "T", lines: ["one"] });
    expect(d.s.overlay).toEqual({ title: "T", lines: ["one"] });
  });
});

describe("buildView against a mocked transport", () => {
  const mk = (handlers: Record<string, (p: any) => any>, over: Partial<ReturnType<typeof initialState>> = {}) => {
    const calls: [string, any][] = [];
    return {
      calls,
      ctx: {
        request: async (m: string, p: any) => { calls.push([m, p]); if (!handlers[m]) throw new Error(`Method not found: ${m}`); return handlers[m](p); },
        state: { ...driver().s, cwd: proj, sessionId: "s1", ...over },
        connection: "in-process",
      },
    };
  };

  test("/mcp lists servers, adds a stdio and an http server, removes one", async () => {
    const servers = { servers: [{ name: "fs", status: "connected", serverType: "stdio", source: "user", toolCount: 3 }, { name: "bad", status: "failed", serverType: "http", source: "project", error: "refused" }], summary: { total: 2, connected: 1, failed: 1 } };
    const { calls, ctx } = mk({ list_mcp_servers: () => servers, add_mcp_server: () => ({ success: true }), remove_mcp_server: () => ({ success: true }) });
    const list = await buildView("mcp", "", ctx);
    expect(list.lines.join("\n")).toContain("fs  [connected]  stdio  from user  3 tools");
    expect(list.lines.join("\n")).toContain("error: refused");
    await buildView("mcp", "add files npx -y @x/server /tmp", ctx);
    await buildView("mcp", "add web https://example.test/mcp", ctx);
    await buildView("mcp", "add web2 --sse https://example.test/sse", ctx);
    await buildView("mcp", "remove files", ctx);
    expect(calls.filter(([m]) => m !== "list_mcp_servers")).toEqual([
      ["add_mcp_server", { name: "files", type: "stdio", command: "npx", args: ["-y", "@x/server", "/tmp"] }],
      ["add_mcp_server", { name: "web", type: "http", url: "https://example.test/mcp" }],
      ["add_mcp_server", { name: "web2", type: "sse", url: "https://example.test/sse" }],
      ["remove_mcp_server", { serverName: "files", settingsLevel: "user" }],
    ]);
  });

  test("/mcp reports an error from the harness", async () => {
    const { ctx } = mk({});
    expect((await buildView("mcp", "", ctx)).lines[0]).toContain("Method not found");
  });

  test("/hooks, /skills, /commands, /agents read the config folders", async () => {
    const { ctx } = mk({});
    expect((await buildView("hooks", "", ctx)).lines.join("\n")).toContain("[Execute] echo hi");
    expect((await buildView("skills", "", ctx)).lines.join("\n")).toContain("tidy  [enabled]  project-dir");
    const cmds = (await buildView("commands", "", ctx)).lines.join("\n");
    expect(cmds).toContain("/review <file>  (project)");
    expect(cmds).toContain("$ARGUMENTS");
    expect((await buildView("agents", "", ctx)).lines.join("\n")).toContain("scout  (project, model inherit)");
  });

  test("/diagnostics shows versions, connection, MCP and settings sources", async () => {
    const { ctx } = mk({ list_mcp_servers: () => ({ servers: [{ name: "bad", status: "failed", error: "boom" }], summary: { total: 1, failed: 1 } }) }, { sessionId: "s1", modelId: "m1" });
    const text = (await buildView("diagnostics", "", ctx)).lines.join("\n");
    expect(text).toContain("Rigwell");
    expect(text).toContain("Transport    in-process");
    expect(text).toContain("bad: boom");
    expect(text).toContain("project");
    expect(text).toContain("settings.json");
    expect(text).toContain("issue");
  });

  test("/statusline runs the command and documents the stdin JSON", async () => {
    const { ctx } = mk({});
    const text = (await buildView("statusline", "", ctx)).lines.join("\n");
    expect(text).toContain("status-ok");
    expect(text).toContain("used_percent");
  });

  test("/automations lists and acts through the automation RPCs", async () => {
    const a = { id: "ab12cd34", name: "nightly", status: "active", schedule: "0 3 * * *", trigger: "schedule", runCount: 2, lastRunAt: "t" };
    const { calls, ctx } = mk({ list_automations: () => ({ automations: [a] }), pause_automation: () => ({}), run_automation: () => ({ runId: "r1" }), get_automation_history: () => ({ runs: [{ startedAt: "t0", status: "success" }] }) });
    expect((await buildView("automations", "", ctx)).lines.join("\n")).toContain("nightly  [active]  0 3 * * *  id ab12cd34");
    expect((await buildView("automations", "pause nightly", ctx)).lines[0]).toBe('Paused "nightly".');
    expect((await buildView("automations", "run ab12", ctx)).lines[0]).toContain("r1");
    expect((await buildView("automations", "history nightly", ctx)).lines[0]).toContain("success");
    expect((await buildView("automations", "pause nope", ctx)).lines[0]).toContain("No automation matches");
    expect(calls.some(([m, p]) => m === "pause_automation" && p.id === "ab12cd34")).toBe(true);
  });

  test("/automations without the daemon says so", async () => {
    const { ctx } = mk({});
    expect((await buildView("automations", "", ctx)).lines[0]).toContain("daemon");
  });
});

describe("rewind", () => {
  const talk = () => {
    let d = key(type(driver(), "first"), "enter");
    d = note(d, { type: "agent_turn_completed", reason: "completed" });
    d = key(type(d, "second"), "enter");
    return note(d, { type: "agent_turn_completed", reason: "completed" });
  };

  test("/rewind-conversation lists user messages, asks the mode, then rewinds", () => {
    let d = key(type(talk(), "/rewind-conversation"), "enter");
    const panel = d.s.panels[0];
    expect(panel.title).toBe("Rewind to an earlier message");
    expect(panel.options.map((o) => o.label)).toEqual(["first", "second"]);
    expect(panel.selected).toBe(1);
    d = key(d, "up");
    d = key(d, "enter");
    expect(d.s.panels[0].options.map((o) => o.value)).toEqual(["files", "conv", "cancel"]);
    d = key(d, "enter");
    expect(d.effects.at(-1)).toEqual({ type: "rewind", messageId: "t-1", restoreFiles: true });
  });

  test("choosing conversation only, or cancel", () => {
    let d = key(type(talk(), "/rewind-conversation"), "enter");
    d = key(d, "enter");
    d = key(d, "char", "2");
    expect(d.effects.at(-1)).toEqual({ type: "rewind", messageId: "t-2", restoreFiles: false });
    d = key(type(talk(), "/rewind-conversation"), "enter");
    d = key(d, "enter");
    const before = d.effects.length;
    d = key(d, "char", "3");
    expect(d.effects.length).toBe(before);
    expect(d.s.panels.length).toBe(0);
  });

  test("double Esc on empty input opens the picker; with text it only clears the input", () => {
    let d = key(talk(), "esc", undefined, 100);
    d = key(d, "esc", undefined, 100);
    expect(d.s.panels[0]?.action.type).toBe("rewind_pick");
    d = key(d, "esc");
    d = key(type(d, "draft"), "esc", undefined, 5000);
    d = key(d, "esc", undefined, 100);
    expect(d.s.input.text).toBe("");
    expect(d.s.panels.length).toBe(0);
  });

  test("nothing to rewind to says so", () => {
    const d = key(type(driver(), "/rewind-conversation"), "enter");
    expect(d.s.items.at(-1)).toMatchObject({ kind: "info", level: "error" });
  });

  test("while running it asks to stop first", () => {
    let d = key(type(driver(), "go"), "enter");
    d = key(type(d, "/rewind-conversation"), "enter");
    expect(d.s.panels[0].title).toBe("Stop the current run?");
  });

  test("rewound truncates the transcript, restores the text into the input", () => {
    let d = talk();
    d = ev(d, { type: "rewound", messageId: "t-1", text: "first", removedCount: 4, restoredFiles: ["a.ts"] });
    expect(d.s.items.map((i) => i.kind)).toEqual(["info"]);
    expect((d.s.items[0] as any).text).toContain("4 messages removed, 1 file restored");
    expect(d.s.input.text).toBe("first");
  });

  test("history items keep their message ids", () => {
    const d = ev(driver(), { type: "session_ready", fresh: true, result: { sessionId: "s", session: { messages: [{ id: "m9", role: "user", content: [{ type: "text", text: "hi" }] }] } } });
    expect(d.s.items[0]).toEqual({ kind: "user", text: "hi", id: "m9" });
  });
});

describe("scrolling", () => {
  const long = () => {
    let d = driver({ rows: 20, cols: 60 });
    for (let i = 0; i < 8; i++) {
      d = key(type(d, `question ${i}`), "enter");
      d = note(d, { type: "assistant_text_delta", messageId: `a${i}`, blockIndex: 0, textDelta: Array.from({ length: 6 }, (_, k) => `answer ${i} line ${k}`).join("\n") });
      d = note(d, { type: "agent_turn_completed", reason: "completed" });
    }
    return d;
  };
  const screen = (d: ReturnType<typeof long>) => stripAnsi(render(d.s, { width: 60, height: 20, color: false }).lines.join("\n"));

  test("keys are parsed", () => {
    expect(parseKeys("\x1b[5~\x1b[6~\x1b[5;3~\x1b[6;3~\x1b[1;3A\x1b[1;3B").map((k) => k.name)).toEqual(["pageup", "pagedown", "alt+pageup", "alt+pagedown", "alt+up", "alt+down"]);
  });

  test("PageUp shows older lines, PageDown comes back, sending resets", () => {
    let d = long();
    expect(screen(d)).toContain("answer 7 line 5");
    expect(screen(d)).not.toContain("question 0");
    d = key(d, "pageup");
    expect(d.s.scroll).toBeGreaterThan(0);
    const up = screen(d);
    expect(up).toContain("more line");
    expect(up).not.toContain("answer 7 line 5");
    for (let i = 0; i < 10; i++) d = key(d, "alt+pageup");
    expect(screen(d)).toContain("question 0");
    d = key(d, "pagedown");
    d = key(d, "pagedown");
    expect(d.s.scroll).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 30; i++) d = key(d, "pagedown");
    expect(d.s.scroll).toBe(0);
    d = key(d, "pageup");
    d = key(type(d, "new"), "enter");
    expect(d.s.scroll).toBe(0);
  });

  test("Alt+Up moves one user turn at a time", () => {
    let d = long();
    d = key(d, "alt+up");
    expect(screen(d)).toContain("question 7");
    d = key(d, "alt+up");
    expect(screen(d)).toContain("question 6");
    d = key(d, "alt+down");
    expect(screen(d)).toContain("question 7");
  });
});

describe("attention", () => {
  test("a completed turn and a request each raise one attention effect; cancelled does not", () => {
    let d = rawEv(driver(), { type: "notification", n: { type: "agent_turn_completed", reason: "completed" }, now: 1 });
    expect(d.effects.filter((e) => e.type === "attention")).toEqual([{ type: "attention", kind: "completion" }]);
    d = rawEv(driver(), { type: "notification", n: { type: "agent_turn_completed", reason: "cancelled" }, now: 1 });
    expect(d.effects.some((e) => e.type === "attention")).toBe(false);
    d = rawEv(driver(), { type: "request", id: "r", method: "ask_user", params: { questions: [{ index: 1, question: "q", options: ["a"] }] } });
    expect(d.effects).toEqual([{ type: "attention", kind: "awaiting" }]);
  });

  test("settings: defaults, flat and under general", () => {
    expect(soundSettings({})).toEqual({ enableCompletionBell: false, completionSound: "off", awaitingInputSound: "ack", soundVolume: 100, soundFocusMode: "always" });
    expect(soundSettings({ enableCompletionBell: true, general: { completionSound: "bell", soundVolume: 50, soundFocusMode: "unfocused" } })).toMatchObject({ enableCompletionBell: true, completionSound: "bell", soundVolume: 50, soundFocusMode: "unfocused" });
    expect(soundSettings({ soundVolume: 900 }).soundVolume).toBe(100);
  });

  test("focus mode", () => {
    expect(focusAllows("always", false)).toBe(true);
    expect(focusAllows("focused", false)).toBe(false);
    expect(focusAllows("focused", undefined)).toBe(true);
    expect(focusAllows("unfocused", true)).toBe(false);
    expect(focusAllows("unfocused", false)).toBe(true);
  });

  test("OSC 9;4 progress sequences", () => {
    expect(progressSequence("working")).toBe("\x1b]9;4;3;\x07");
    expect(progressSequence("waiting")).toBe("\x1b]9;4;4;\x07");
    expect(progressSequence("idle")).toBe("\x1b]9;4;0;\x07");
  });

  test("playSound: off does nothing, bell rings, built-in tone goes to the player, failure falls back to the bell at volume 100 only", async () => {
    let bells = 0;
    const ran: [string, string[]][] = [];
    const player = { cmd: "paplay", args: (f: string, v: number) => [`--volume=${v}`, f], scales: true };
    const base = { bell: () => { bells++; }, player, run: async (c: string, a: string[]) => { ran.push([c, a]); return true; } };
    await playSound("off", 100, base);
    expect(bells + ran.length).toBe(0);
    await playSound("bell", 100, base);
    expect(bells).toBe(1);
    await playSound("ack", 80, base);
    expect(ran[0][0]).toBe("paplay");
    expect(ran[0][1][0]).toBe("--volume=80");
    expect(ran[0][1][1]).toMatch(/\.wav$/);
    const fail = { ...base, run: async () => false };
    await playSound("ack", 100, fail);
    expect(bells).toBe(2);
    await playSound("ack", 60, fail);
    expect(bells).toBe(2);
    await playSound("ack", 100, { ...base, player: null });
    expect(bells).toBe(3);
    await playSound("/no/such/file.wav", 100, base);
    expect(bells).toBe(4);
  });

  test("a custom WAV is rescaled when the player cannot scale", async () => {
    const f = join(home, "c.wav");
    writeFileSync(f, makeWav([440], 50));
    const ran: string[][] = [];
    await playSound(f, 50, { bell: () => {}, player: { cmd: "aplay", args: (file) => ["-q", file], scales: false }, run: async (_c, a) => { ran.push(a); return true; } });
    expect(ran[0][1]).not.toBe(f);
    const orig = makeWav([440], 50, 100);
    const half = scaleWav(orig, 50)!;
    expect(Math.abs(half.readInt16LE(60))).toBeLessThanOrEqual(Math.abs(orig.readInt16LE(60)) / 2 + 1);
    expect(scaleWav(Buffer.from("nope"), 50)).toBeNull();
  });

  test("player lookup order", () => {
    const has = (...names: string[]) => (c: string) => (names.includes(c) ? "/bin/" + c : null);
    expect(findPlayer("darwin", has("afplay"))?.cmd).toBe("afplay");
    expect(findPlayer("linux", has("aplay", "ffplay"))?.cmd).toBe("aplay");
    expect(findPlayer("linux", has("paplay", "aplay"))?.cmd).toBe("paplay");
    expect(findPlayer("linux", has())).toBeNull();
  });
});

describe("custom status line", () => {
  test("config validation", () => {
    expect(statusLineConfig({})).toBeNull();
    expect(statusLineConfig({ statusLine: { type: "command", command: "x", maxRows: 9, padding: 2 } })).toEqual({ command: "x", padding: 2, maxRows: 3 });
    expect(statusLineConfig({ statusLine: { type: "text", command: "x" } })).toBeNull();
  });

  test("runs the command with JSON on stdin, caps rows, reports failures and timeouts", async () => {
    const input = statusLineInput(driver({ contextUsed: 500, contextLimit: 1000 }).s);
    expect(input.context).toEqual({ used_tokens: 500, limit_tokens: 1000, used_percent: 50 });
    const cat = await runStatusLine({ command: jsCommand(proj, 'process.stdout.write(require("fs").readFileSync(0))'), padding: 0, maxRows: 1 }, input, proj);
    expect(cat.ok && JSON.parse(cat.text).model.id).toBe("m1");
    const rows = await runStatusLine({ command: jsCommand(proj, 'console.log("a\\nb\\nc")'), padding: 0, maxRows: 2 }, input, proj);
    expect(rows).toEqual({ ok: true, text: "a\nb" });
    expect(await runStatusLine({ command: "exit 3", padding: 0, maxRows: 1 }, input, proj)).toEqual({ ok: false, hint: "Status line exited 3. Run /statusline." });
    const slow = await runStatusLine({ command: sleepCommand(proj, 2), padding: 0, maxRows: 1 }, input, proj, 100);
    expect(slow.ok).toBe(false);
    expect(!slow.ok && slow.hint).toContain("/statusline");
  });

  test("it is drawn above the status bar, and a hint shows on failure", () => {
    let d = ev(driver(), { type: "status_line", text: "branch main\n2 files", padding: 1 });
    let lines = stripAnsi(render(d.s, { width: 60, height: 24, color: false }).lines.join("\n")).split("\n");
    const i = lines.indexOf(" branch main");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe(" 2 files");
    expect(lines[i + 2]).toContain("context:");
    d = ev(d, { type: "status_line", text: undefined, hint: "Status line timed out. Run /statusline." });
    lines = stripAnsi(render(d.s, { width: 60, height: 24, color: false }).lines.join("\n")).split("\n");
    expect(lines.some((l) => l.includes("Run /statusline"))).toBe(true);
  });

  test("turn end and session start request a refresh", () => {
    const d = rawEv(driver(), { type: "notification", n: { type: "agent_turn_completed", reason: "completed" }, now: 1 });
    expect(d.effects.some((e) => e.type === "status_line")).toBe(true);
  });
});

describe("header and footer", () => {
  test("loaded counts and the config-issue count", () => {
    const d = ev(driver(), { type: "extras", custom: [], skills: 3, mcps: 0, issues: 2 });
    const text = stripAnsi(render(d.s, { width: 100, height: 24, color: false }).lines.join("\n"));
    expect(text).toContain("Skills: Loaded +3 · MCPs: Not found");
    expect(text).toContain("2 config issues: /diagnostics");
  });
});
