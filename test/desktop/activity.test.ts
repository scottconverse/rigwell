import { describe, expect, test } from "bun:test";
import { activityLabel, groupActivity, liveStep } from "../../desktop/renderer/lib/activity.ts";
import type { Item } from "../../desktop/renderer/lib/transcript.ts";

const tool = (id: string, name: string, status: "running" | "ok" | "error" = "ok"): Item => ({ kind: "tool", id, name, input: {}, status });
const think = (id: string): Item => ({ kind: "thinking", id, text: "t" });
const say = (id: string): Item => ({ kind: "assistant", id, text: "a" });
const user = (id: string): Item => ({ kind: "user", id, text: "u" });

describe("groupActivity", () => {
  test("empty list has no rows", () => expect(groupActivity([])).toEqual([]));

  test("one tool stays a plain row", () => {
    expect(groupActivity([tool("a", "Read")]).map((r) => r.kind)).toEqual(["item"]);
  });

  test("thinking with no tool is not folded", () => {
    expect(groupActivity([think("a"), think("b")]).map((r) => r.kind)).toEqual(["item", "item"]);
  });

  test("adjacent tools and thinking fold, and text splits groups", () => {
    const rows = groupActivity([tool("a", "Read"), think("b"), tool("c", "Grep"), say("d"), tool("e", "Read"), tool("f", "Edit")]);
    expect(rows.map((r) => r.kind)).toEqual(["group", "item", "group"]);
    const g = rows[0]!;
    if (g.kind !== "group") throw new Error("not a group");
    expect(g.id).toBe("activity-a");
    expect(activityLabel(g)).toBe("Activity · 3 events");
    expect(g.autoOpen).toBe(false);
  });

  test("a failed tool keeps the group open and shows in the label", () => {
    const g = groupActivity([tool("a", "Read"), tool("b", "Execute", "error")])[0]!;
    if (g.kind !== "group") throw new Error("not a group");
    expect(g.autoOpen).toBe(true);
    expect(activityLabel(g)).toBe("Activity · 2 events, 1 failed");
  });

  test("a running tool keeps the group open only during a turn", () => {
    const items = [tool("a", "Read"), tool("b", "Execute", "running")];
    const during = groupActivity(items, true)[0]!, after = groupActivity(items, false)[0]!;
    if (during.kind !== "group" || after.kind !== "group") throw new Error("not a group");
    expect(during.autoOpen).toBe(true);
    expect(after.autoOpen).toBe(false);
  });
});

describe("liveStep", () => {
  test("no running tool says Working", () => expect(liveStep([tool("a", "Read"), say("b")])).toBe("Working"));
  test("names one command", () => expect(liveStep([tool("a", "Execute", "running")])).toBe("Running 1 command"));
  test("counts file changes across tools", () => {
    expect(liveStep([tool("a", "Edit", "running"), tool("b", "Create", "running"), tool("c", "ApplyPatch", "running")])).toBe("Making 3 file changes");
  });
  test("names reads, searches and pages", () => {
    expect(liveStep([tool("a", "Read", "running"), tool("b", "Grep", "running"), tool("c", "FetchUrl", "running")])).toBe("Reading 1 file, Running 1 search, Fetching 1 page");
  });
  test("an unknown tool has a plain label", () => expect(liveStep([tool("a", "Custom", "running")])).toBe("Using 1 tool"));
  test("a message sent during a turn does not hide the running tool", () => {
    expect(liveStep([tool("a", "Execute", "running"), user("b")])).toBe("Running 1 command");
  });
  test("a tool left running by an older turn is ignored", () => {
    expect(liveStep([tool("a", "Execute", "running"), say("b"), tool("c", "Read", "running")])).toBe("Reading 1 file");
    expect(liveStep([tool("a", "Execute", "running"), user("b"), tool("c", "Read", "running")])).toBe("Reading 1 file");
  });
});
