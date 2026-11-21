import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupActivity } from "../../desktop/renderer/lib/activity.ts";
import { DIVIDER_GAP_MS, timeLabel, withDividers } from "../../desktop/renderer/lib/timeline.ts";
import { fromMessages, stampNew, type Item } from "../../desktop/renderer/lib/transcript.ts";
import { readMessageTimes, type SessionFiles } from "../../src/storage/transcript.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const user = (id: string, time?: number): Item => ({ kind: "user", id, text: id, ...(time === undefined ? {} : { at: time }) });
const labels = (items: Item[], now: number) => withDividers(groupActivity(items), now, "en-US").flatMap((r) => (r.kind === "divider" ? [r.label] : []));

describe("time dividers", () => {
  test("old messages with no time get no divider", () => {
    expect(labels([user("a"), user("b"), user("c")], at(21, 12))).toEqual([]);
  });

  test("a message with no time does not break the gap check", () => {
    expect(labels([user("a", at(21, 9)), user("b"), user("c", at(21, 14, 14))], at(21, 15))).toEqual(["Today 2:14 PM"]);
  });

  test("a short gap has no divider and the full gap has one", () => {
    const start = at(21, 9);
    expect(labels([user("a", start), user("b", start + DIVIDER_GAP_MS - 1)], at(21, 12))).toEqual([]);
    expect(labels([user("a", start), user("b", start + DIVIDER_GAP_MS)], at(21, 12))).toEqual(["Today 9:30 AM"]);
  });

  test("a gap across midnight shows a divider even when it is short", () => {
    expect(labels([user("a", at(20, 23, 55)), user("b", at(21, 0, 5))], at(21, 12))).toEqual(["Today 12:05 AM"]);
  });

  test("labels name today, yesterday, a date, and another year", () => {
    const now = at(21, 12);
    expect(timeLabel(at(21, 14, 14), now, "en-US")).toBe("Today 2:14 PM");
    expect(timeLabel(at(20, 14, 14), now, "en-US")).toBe("Yesterday 2:14 PM");
    expect(timeLabel(at(3, 14, 14), now, "en-US")).toBe("Nov 3 2:14 PM");
    expect(timeLabel(new Date(2025, 10, 3, 14, 14).getTime(), now, "en-US")).toBe("Nov 3, 2025 2:14 PM");
  });
});

describe("message times", () => {
  test("a resumed session gets its stored times, and a message with none stays without", () => {
    const stamp = new Date(at(20, 9)).toISOString();
    const items = fromMessages([
      { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "hi" }] },
    ], { m1: stamp });
    expect(items[0]!.at).toBe(at(20, 9));
    expect(items[1]!.at).toBeUndefined();
  });

  test("new live items get the arrival time and old items keep theirs", () => {
    const prev = [user("a", 5)];
    const next = stampNew(prev, [...prev, user("b")], 99);
    expect(next.map((i) => i.at)).toEqual([5, 99]);
  });

  test("readMessageTimes reads valid times and skips bad lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "rigwell-times-"));
    try {
      const transcriptPath = join(dir, "t.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: "message", id: "m1", timestamp: "2026-11-20T09:00:00.000Z", message: {} }),
        JSON.stringify({ type: "message", id: "m2", timestamp: "not a time", message: {} }),
        JSON.stringify({ type: "message", id: "m3", message: {} }),
        '{"timestamp": broken',
      ].join("\n"));
      const times = readMessageTimes({ transcriptPath } as SessionFiles, ["m1", "m2", "m3"]);
      expect(times).toEqual({ m1: "2026-11-20T09:00:00.000Z" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
