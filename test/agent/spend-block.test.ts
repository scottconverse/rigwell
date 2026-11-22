// A spend cap that blocks a model request mid-turn must end the turn as stopped/idle and keep the block message.
import { expect, test } from "bun:test";
import { call, makeStubSession } from "./helpers.ts";
import { SpendLimitError } from "../../src/spend/spend.ts";

test("a mid-turn spend block ends the turn idle with the block message kept", async () => {
  const s = makeStubSession((_req, n) => {
    if (n === 0) return call("LS", { path: "." }, "ls1");
    throw new SpendLimitError("Overall day spend cap reached. Check Usage settings before starting more requests.", "overall");
  }, { skipPermissions: true });
  s.session.addUserMessage("do it", "turn-1");
  await s.session.settled();
  await s.session.idle();
  expect(s.session.workingState).toBe("idle");
  expect(s.session.lastTurn?.reason).toBe("model_request_rejected");
  const completed = s.notes.filter((n) => n.type === "agent_turn_completed");
  expect(completed.at(-1)?.reason).toBe("model_request_rejected");
  const block = s.notes.filter((n) => n.type === "error" && /spend cap reached/i.test(String(n.message)));
  expect(block.length).toBeGreaterThan(0);
});
