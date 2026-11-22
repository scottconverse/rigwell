// The first-message session block is written before the user switches to mission mode, so it keeps saying the old
// mode. Switching to mission must tell the model it is in mission mode and where the plan-file format is, so it does
// not read Rigwell's own source to learn the format.
import { expect, test } from "bun:test";
import { makeStubSession, text } from "./helpers.ts";

test("switching to mission mode adds a visible mission notice before the next turn", async () => {
  const s = makeStubSession(() => text("ok"));
  s.session.updateSettings({ interactionMode: "mission" });
  s.session.addUserMessage("plan it", "turn-1");
  await s.session.settled();
  await s.session.idle();
  const sent = JSON.stringify(s.requests[0]?.messages ?? s.stored);
  expect(sent).toContain("Mission mode is now on");
  expect(sent).toContain("ProposeMission");
  expect(sent).toContain("features.json");
});

test("switching back to normal mode does not claim mission mode is on", async () => {
  const s = makeStubSession(() => text("ok"), { settings: { modelId: "custom:Stub-0", reasoningEffort: "off", interactionMode: "mission", autonomyLevel: "high" } });
  s.session.updateSettings({ interactionMode: "auto" });
  s.session.addUserMessage("carry on", "turn-1");
  await s.session.settled();
  await s.session.idle();
  const sent = JSON.stringify(s.requests[0]?.messages ?? s.stored);
  expect(sent).not.toContain("Mission mode is now on");
});
