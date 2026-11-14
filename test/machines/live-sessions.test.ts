import { expect, test } from "bun:test";
import { makeStubSession, text } from "../agent/helpers.ts";
import { liveSessions, runningSessionCount, stopLiveSessions } from "../../src/machines/live-sessions.ts";
import { zeroUsage, type ModelRequest, type StreamEvent } from "../../src/core/types.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { rmSync } from "node:fs";

test("fleet counts and interrupts engines without socket tabs and allows a later user turn", async () => {
  const env = tmpEnv(); let ready!: () => void;
  const entered = new Promise<void>((r) => ready = r);
  let turns = 0;
  const fixture = makeStubSession(() => text("later"), { streamWithRetry: async function* (_adapter: unknown, req: ModelRequest): AsyncGenerator<StreamEvent> {
    if (++turns === 1) { ready();
      await new Promise<void>((resolve) => { if (req.signal!.aborted) resolve(); else req.signal!.addEventListener("abort", () => resolve(), { once: true }); });
    } else yield { type: "message_done", content: [{ type: "text", text: "Resumed" }], stopReason: "end_turn", usage: zeroUsage() };
  } as any });
  try {
    expect(liveSessions().some((s) => s.id === fixture.session.id)).toBe(true);
    fixture.session.addUserMessage("Wait for cancellation"); await entered;
    fixture.session.addUserMessage("Queued message must not run");
    let backgroundStopped = false;
    const jobId = fixture.session.jobs.startBackground({ kind: "execute", title: "cancel fixture", run: (signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { backgroundStopped = true; resolve({ content: "stopped", isError: true }); }, { once: true }); }) });
    expect(runningSessionCount()).toBe(1);
    const stopping = stopLiveSessions();
    expect(() => fixture.session.addUserMessage("During stop")).toThrow("stopping its sessions");
    expect(await stopping).toMatchObject({ stopped: 1, runningSessions: 0 });
    expect(fixture.session.queuedMessages()).toEqual([]);
    expect(backgroundStopped).toBe(true); expect(fixture.session.jobs.get(jobId)?.reported).toBe(true);
    expect(turns).toBe(1);
    fixture.session.addUserMessage("Resume after stop"); await fixture.session.idle(); expect(turns).toBe(2);
    await fixture.session.end(); expect(liveSessions()).toEqual([]);
  } finally { fixture.session.interrupt(true); await fixture.session.end(); rmSync(fixture.cwd, { recursive: true, force: true }); env.cleanup(); }
}, 3000);
