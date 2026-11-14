import { expect, test } from "bun:test";
import { BrowserService } from "../../src/sidepane/browser.ts";

test("owned browser tabs stay in their explicit context and cannot close a startup or foreign tab", async () => {
  let targets = [
    { targetId: "startup", type: "page", url: "about:blank" },
    { targetId: "owned", type: "page", url: "about:blank", browserContextId: "session-context" },
    { targetId: "foreign", type: "page", url: "about:blank", browserContextId: "foreign-context" },
  ];
  const commands: any[] = [];
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("upgrade", { status: 400 }); },
    websocket: { message(ws, raw) {
      const m = JSON.parse(raw.toString()); commands.push(m); let result = {};
      if (m.method === "Target.getTargets") result = { targetInfos: targets };
      if (m.method === "Target.createTarget") { targets.push({ targetId: "created", type: "page", ...m.params }); result = { targetId: "created" }; }
      if (m.method === "Target.closeTarget") targets = targets.filter((t) => t.targetId !== m.params.targetId);
      ws.send(JSON.stringify({ id: m.id, result }));
    } },
  });
  const service = new BrowserService({ cdpUrl: `ws://127.0.0.1:${web.port}/devtools/browser/fixture`, browserContextId: "session-context" });
  try {
    expect((await service.tabs()).map((t) => t.id)).toEqual(["owned"]);
    for (const id of ["startup", "foreign"]) {
      let failure: unknown; try { await service.closeTab(id); } catch (error) { failure = error; }
      expect(String(failure)).toContain("in this browser context");
    }
    expect(commands.some((m) => m.method === "Target.closeTarget")).toBe(false);
    expect(await service.newTab()).toBe("created");
    expect(commands.find((m) => m.method === "Target.createTarget").params.browserContextId).toBe("session-context");
    await service.closeTab("created"); expect((await service.tabs()).map((t) => t.id)).toEqual(["owned"]);
  } finally { service.disconnect(); web.stop(true); }
});
