// A message added right after a turn goes idle (found by the perf benchmarks) must start a turn, not be stranded.
import { expect, test } from "bun:test";
import { makeStubSession, text } from "./helpers.ts";

test("a message queued a few microtasks after the idle notification still runs", async () => {
  for (let ticks = 0; ticks < 12; ticks++) {
    const notes: any[] = [];
    const s = makeStubSession(() => text("ok"), { notes });
    let fired = false;
    notes.push = (n: any) => {
      Array.prototype.push.call(notes, n);
      if (!fired && n.type === "agent_working_state_changed" && n.newState === "idle") {
        fired = true;
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < ticks; i++) p = p.then(() => {});
        void p.then(() => s.session.addUserMessage("again"));
      }
      return notes.length;
    };
    s.session.addUserMessage("first");
    await s.session.settled();
    await Bun.sleep(20);
    await s.session.settled();
    expect(s.requests.length, `ticks=${ticks}`).toBe(2);
  }
});
