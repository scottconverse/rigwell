// Final gap wave: RecommendMission (spec 15.1) and UpgradeModel (spec 4.5).
import { expect, test } from "bun:test";
import { MODEL, call, makeStubSession, text } from "./helpers.ts";

const STRONG = { ...MODEL, id: "custom:Strong-1", model: "strong", displayName: "Strong" };
const flat = (r: unknown) => JSON.stringify(r);
const names = (r: any) => r.tools.map((t: any) => t.name);

function interactive(answer: (p: any) => any) {
  const asked: any[] = [];
  return { asked, set: (s: any) => { s.host.requestPermission = async (p: any) => { asked.push(p); return answer(p); }; } };
}

test("RecommendMission: offered only when a client can answer; accepting enters mission mode", async () => {
  let entered = 0;
  const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("RecommendMission", { reason: "twelve independent features" }) : text("ok")), {
    autoRejectPermissionRequests: false,
    enterMissionMode: async () => { entered++; return { entered: true }; },
  });
  const a = interactive(() => ({ selectedOption: "proceed_once" }));
  a.set(session);
  session.addUserMessage("build the whole app");
  await session.idle();
  expect(names(requests[0])).toContain("RecommendMission");
  expect(a.asked[0].toolUses[0].confirmationType).toBe("recommend_mission");
  expect(a.asked[0].toolUses[0].details).toEqual({ reason: "twelve independent features" });
  expect(entered).toBe(1);
  expect(flat(requests[1])).toContain("Mission mode is on");
});

test("RecommendMission: declined stays in the session; headless and mission mode do not offer it", async () => {
  let entered = 0;
  const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("RecommendMission", { reason: "big" }) : text("ok")), {
    autoRejectPermissionRequests: false, enterMissionMode: async () => { entered++; return { entered: true }; },
  });
  interactive(() => ({ selectedOption: "cancel", comment: "not now" })).set(session);
  session.addUserMessage("x");
  await session.idle();
  expect(entered).toBe(0);
  expect(flat(requests[1])).toContain("declined mission mode");
  expect(flat(requests[1])).toContain("not now");

  const headless = makeStubSession(() => text("hi"), { enterMissionMode: async () => ({ entered: true }) });
  headless.session.addUserMessage("x");
  await headless.session.idle();
  expect(names(headless.requests[0])).not.toContain("RecommendMission");

  const mission = makeStubSession(() => text("hi"), {
    autoRejectPermissionRequests: false, enterMissionMode: async () => ({ entered: true }),
    settings: { modelId: MODEL.id, reasoningEffort: "off", interactionMode: "mission", autonomyLevel: "high" },
  });
  interactive(() => ({ selectedOption: "cancel" })).set(mission.session);
  mission.session.addUserMessage("x");
  await mission.session.idle();
  expect(names(mission.requests[0])).not.toContain("RecommendMission");
});

test("UpgradeModel: asks, then switches to the next model on the path and queues the tool-mode notice", async () => {
  const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("UpgradeModel", { reason: "stuck on a hard proof" }) : text("ok")), {
    autoRejectPermissionRequests: false, modelUpgradePath: [MODEL.id, STRONG.id], scriptToolModels: [STRONG.id],
    resolveModel: (id) => (id === STRONG.id ? STRONG : MODEL),
  });
  const a = interactive(() => ({ selectedOption: "proceed_once" }));
  a.set(session);
  session.addUserMessage("hard task");
  await session.idle();
  expect(names(requests[0])).toContain("UpgradeModel");
  expect(a.asked[0].toolUses[0].confirmationType).toBe("upgrade_model");
  expect(a.asked[0].toolUses[0].details).toMatchObject({ toModelId: STRONG.id, fromModelId: MODEL.id });
  expect(session.settings.modelId).toBe(STRONG.id);
  expect(flat(requests[1])).toContain("now uses");
  expect(flat(requests[1])).toContain("reach tools only through Script"); // mode-change notice
  // Path exhausted: the tool is no longer offered.
  session.addUserMessage("again");
  await session.idle();
  expect(names(requests[requests.length - 1])).not.toContain("UpgradeModel");
});

test("UpgradeModel: declined keeps the model; not offered without a path or a client", async () => {
  const { session, requests } = makeStubSession((req, n) => (n === 0 ? call("UpgradeModel", { reason: "r" }) : text("ok")), {
    autoRejectPermissionRequests: false, modelUpgradePath: [STRONG.id], resolveModel: (id) => (id === STRONG.id ? STRONG : MODEL),
  });
  interactive(() => ({ selectedOption: "cancel" })).set(session);
  session.addUserMessage("x");
  await session.idle();
  expect(session.settings.modelId).toBe(MODEL.id);
  expect(flat(requests[1])).toContain("declined the model upgrade");

  const none = makeStubSession(() => text("hi"), { autoRejectPermissionRequests: false });
  interactive(() => ({ selectedOption: "cancel" })).set(none.session);
  none.session.addUserMessage("x");
  await none.session.idle();
  expect(names(none.requests[0])).not.toContain("UpgradeModel");
});
