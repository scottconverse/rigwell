import { describe, expect, test } from "bun:test";
import { findCommand, matchCommands } from "../../src/tui/commands.ts";
import { familyTree, groupSessions, sessionLabel } from "../../src/tui/sessiontree.ts";
import { driver, ev, key, type } from "./helpers.ts";
import { initialState, reduce } from "../../src/tui/reducer.ts";

describe("/side alias", () => {
  test("resolves to btw, completes, and shows once in /help", () => {
    expect(findCommand("side")?.name).toBe("btw");
    expect(matchCommands("si").map((c) => c.name)).toEqual(["btw"]);
    let d = driver();
    "/help".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    const lines = (d.s.overlay?.lines ?? []).filter((l) => l.includes("/btw") || l.includes("/side"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alias: /side");
  });
  test("/side <q> sends a btw effect", () => {
    let d = driver();
    "/side why".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    expect(d.effects.some((e) => e.type === "btw" && e.question === "why")).toBe(true);
  });
});

const rows = [
  { id: "c-fork2", title: "fork of fork", parent: "b-fork1" },
  { id: "z-other", title: "other" },
  { id: "a-root", title: "root" },
  { id: "b-fork1", title: "fork 1", parent: "a-root" },
  { id: "d-orphan", title: "orphan", parent: "gone" },
  { id: "e-fork1b", title: "fork 1b", parent: "a-root" },
];

describe("session tree", () => {
  test("groupSessions puts forks under parents, orphans at top", () => {
    const g = groupSessions(rows).map((t) => `${t.depth}:${t.row.id}`);
    expect(g).toEqual(["0:z-other", "0:a-root", "1:b-fork1", "2:c-fork2", "1:e-fork1b", "0:d-orphan"]);
  });
  test("familyTree finds the root from any member and excludes others", () => {
    const t = familyTree(rows, "c-fork2").map((x) => x.row.id);
    expect(t).toEqual(["a-root", "b-fork1", "c-fork2", "e-fork1b"]);
    expect(familyTree(rows, "nope")).toEqual([]);
    expect(familyTree(rows, undefined)).toEqual([]);
  });
  test("cycles do not loop or drop rows", () => {
    const g = groupSessions([{ id: "a", parent: "b" }, { id: "b", parent: "a" }]);
    expect(g.map((x) => x.row.id).sort()).toEqual(["a", "b"]);
  });
  test("labels indent and mark current", () => {
    const f = familyTree(rows, "b-fork1");
    expect(sessionLabel(f[0], "b-fork1")).toStartWith("a-root");
    expect(sessionLabel(f[1], "b-fork1")).toContain("└ b-fork1");
    expect(sessionLabel(f[1], "b-fork1")).toContain("(current)");
  });
  test("/tree and /sessions build panels from the list", () => {
    let d = driver({ sessionId: "b-fork1" });
    "/tree".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    expect(d.effects.some((e) => e.type === "list_sessions" && e.tree === true)).toBe(true);
    const t = ev(d, { type: "sessions", sessions: rows.map((r) => ({ ...r })), tree: true });
    const p = t.s.panels.at(-1)!;
    expect(p.title).toBe("Session tree");
    expect(p.options.map((o) => o.value)).toEqual(["a-root", "b-fork1", "c-fork2", "e-fork1b"]);
    expect(p.selected).toBe(1);
    const l = ev(driver(), { type: "sessions", sessions: rows.map((r) => ({ ...r })) });
    expect(l.s.panels.at(-1)!.options.map((o) => o.value)).toEqual(["z-other", "a-root", "b-fork1", "c-fork2", "e-fork1b", "d-orphan"]);
  });
});

describe("typeahead during startup", () => {
  const starting = () => driver({ starting: true });
  test("text is kept in the input box while starting", () => {
    let d = starting();
    "hello".split("").forEach((c) => { d = type(d, c); });
    expect(d.s.input.text).toBe("hello");
  });
  test("Enter before ready queues, hints, and sends nothing", () => {
    let d = starting();
    "hello".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    expect(d.effects.filter((e) => e.type === "send")).toEqual([]);
    expect(d.s.pending.queue).toEqual(["hello"]);
    expect(d.s.hint).toContain("will send when ready".replace("w", "W"));
    expect(d.s.input.text).toBe("");
  });
  test("session_ready sends the queued message and keeps half-typed text", () => {
    let d = starting();
    "hello".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    "more".split("").forEach((c) => { d = type(d, c); });
    d = ev(d, { type: "session_ready", result: { sessionId: "s1", session: { messages: [] } }, fresh: true });
    const sends = d.effects.filter((e) => e.type === "send");
    expect(sends.length).toBe(1);
    expect((sends[0] as any).text).toBe("hello");
    expect(d.s.starting).toBe(false);
    expect(d.s.input.text).toBe("more");
    expect(d.s.running).toBe(true);
    expect(d.s.pending.queue).toEqual([]);
  });
  test("after ready Enter sends normally", () => {
    let d = driver();
    expect(initialState({ cwd: "/x" }).starting).toBeUndefined();
    "hi".split("").forEach((c) => { d = type(d, c); });
    d = key(d, "enter");
    expect(d.effects.some((e) => e.type === "send")).toBe(true);
    void reduce;
  });
});
