// The side chat writes switch (spec 17.4): it shows a click at once and is not undone by an old list reply.
import { expect, test } from "bun:test";
import { SessionController } from "../../desktop/renderer/lib/session.ts";

/** A controller whose daemon calls wait until the test answers them. */
function controller() {
  const ctl = new SessionController("/repo");
  const calls: { method: string; params: any; answer(v: unknown): void; fail(e: Error): void }[] = [];
  (ctl as any).request = (method: string, params: any = {}) =>
    new Promise((answer, fail) => calls.push({ method, params, answer, fail }));
  return { ctl, calls, writes: () => ctl.getSnapshot().sideWrites };
}

test("the switch shows the new value before the daemon answers", async () => {
  const { ctl, calls, writes } = controller();
  const on = ctl.setSideWrites(true);
  expect(writes()).toBe(true); // a checkbox test reads the box right after the click
  calls[0]!.answer({ writes: true });
  await on;
  expect(writes()).toBe(true);
  const off = ctl.setSideWrites(false);
  expect(writes()).toBe(false);
  calls[1]!.answer({ writes: false });
  await off;
  expect(writes()).toBe(false);
});

test("the switch goes back when the daemon call fails", async () => {
  const { ctl, calls, writes } = controller();
  const on = ctl.setSideWrites(true);
  calls[0]!.fail(new Error("no session"));
  await expect(on).rejects.toThrow("no session");
  expect(writes()).toBe(false);
});

test("a list reply sent before a click does not put the old value back", async () => {
  const { ctl, calls, writes } = controller();
  const list = ctl.refreshSideChat(); // asked while writes were off
  const on = ctl.setSideWrites(true);
  calls[1]!.answer({ writes: true });
  await on;
  calls[0]!.answer({ entries: [{ id: "e1" }], writes: false }); // the old reply comes last
  await list;
  expect(writes()).toBe(true);
  expect(ctl.getSnapshot().sideChat).toEqual([{ id: "e1" }] as any);
});
