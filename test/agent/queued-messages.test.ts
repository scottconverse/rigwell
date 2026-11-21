// The waiting list: every queue change reaches the views, and a message is never in neither place.
import { expect, test } from "bun:test";
import { makeStubSession, text } from "./helpers.ts";
import { mergeQueued } from "../../desktop/renderer/lib/queued.ts";

const lists = (notes: any[]) => notes.filter((n) => n.type === "queued_messages_changed");
const ids = (n: any) => n.queuedMessages.map((m: any) => m.messageId);

function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

test("a message sent during a turn waits, then is delivered once with its stored text", async () => {
  const notes: any[] = [];
  const g = gated();
  const s = makeStubSession(async (_r, i) => { if (i === 0) await g.gate; return text("ok"); }, { notes });
  s.session.addUserMessage("first", "m1");
  await Bun.sleep(10);
  s.session.addUserMessage("second", "m2");
  expect(s.session.queuedMessages().map((m) => m.messageId)).toEqual(["m2"]);
  expect(ids(lists(notes).at(-1))).toEqual(["m2"]);
  g.open();
  await s.session.settled();
  const delivered = lists(notes).filter((n) => n.delivered?.id === "m2");
  expect(delivered.length).toBe(1);
  expect(ids(delivered[0])).toEqual([]);
  expect(s.session.queuedMessages()).toEqual([]);
});

test("a message stays in the list until the transcript write finishes", async () => {
  const notes: any[] = [];
  const g = gated();
  const s = makeStubSession(() => text("ok"), {
    notes,
    beforeTurn: async () => { await g.gate; return () => {}; },
  });
  s.session.addUserMessage("held", "m1");
  await Bun.sleep(10);
  expect(s.session.queuedMessages().map((m) => m.messageId)).toEqual(["m1"]);
  g.open();
  await s.session.settled();
  expect(s.session.queuedMessages()).toEqual([]);
});

test("interrupt with discard clears the list; a plain interrupt keeps it", async () => {
  const notes: any[] = [];
  const g = gated();
  const s = makeStubSession(async (_r, i) => { if (i === 0) await g.gate; return text("ok"); }, { notes });
  s.session.addUserMessage("first", "m1");
  await Bun.sleep(10);
  s.session.addUserMessage("keep", "m2");
  s.session.interrupt();
  expect(s.session.queuedMessages().map((m) => m.messageId)).toContain("m2");
  s.session.interrupt(true);
  expect(s.session.queuedMessages().map((m) => m.messageId)).not.toContain("m2");
  expect(ids(lists(notes).at(-1))).not.toContain("m2");
  g.open();
  await s.session.settled();
});

test("two views get the same list", async () => {
  const notes: any[] = [];
  const second: any[] = [];
  const g = gated();
  const s = makeStubSession(async (_r, i) => { if (i === 0) await g.gate; return text("ok"); }, { notes });
  s.session.subscribeNotifications((n) => { second.push(n); });
  s.session.addUserMessage("first", "m1");
  await Bun.sleep(10);
  s.session.addUserMessage("second", "m2");
  g.open();
  await s.session.settled();
  expect(lists(second).map(ids)).toEqual(lists(notes).map(ids));
});

test("the view keeps an unanswered message, drops a delivered one, and keeps attachment names", () => {
  const shown = new Map([["a", "hello\n[Attached: x.png]"]]);
  expect(mergeQueued([], [], new Map([["a", "hello\n[Attached: x.png]"]]), shown)).toEqual([{ messageId: "a", text: "hello\n[Attached: x.png]" }]);
  expect(mergeQueued([], [{ messageId: "a", text: "hello" }], new Map(), shown)).toEqual([{ messageId: "a", text: "hello\n[Attached: x.png]" }]);
  expect(mergeQueued([{ kind: "user", id: "a:0", text: "hello" }], [{ messageId: "a", text: "hello" }], new Map([["a", "hello"]]), shown)).toEqual([]);
});
