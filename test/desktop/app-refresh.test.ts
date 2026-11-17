import { expect, test } from "bun:test";
import { AppModel } from "../../desktop/renderer/lib/app-model.ts";

test("an older sidebar refresh cannot hide a newly promoted session", async () => {
  const model = new AppModel();
  const replies: ((value: unknown) => void)[] = [];
  (model as any).control = {
    closed: false,
    request: (method: string) => method === "list_models"
      ? Promise.resolve({ models: [] })
      : new Promise((resolve) => replies.push(resolve)),
  };
  const older = model.refresh();
  const newer = model.refresh();
  replies[1]!({ sessions: [{ sessionId: "promoted", title: "Side chat: question", cwd: "/fixture" }] });
  await newer;
  replies[0]!({ sessions: [] });
  await older;
  expect(model.getSnapshot().sessions.map((s) => s.id)).toEqual(["promoted"]);
});
