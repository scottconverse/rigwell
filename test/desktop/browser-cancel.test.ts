import { expect, test } from "bun:test";
import { BrowserService } from "../../src/sidepane/browser.ts";
import { tmpEnv } from "../storage/helpers.ts";

test("navigation cancellation settles even when CDP withholds the navigation response", async () => {
  let requested!: () => void;
  const navigating = new Promise<void>((resolve) => requested = resolve);
  let held: number | undefined;
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("upgrade", { status: 400 }); },
    websocket: { message(ws, raw) {
      const m = JSON.parse(raw.toString());
      if (m.method === "Page.navigate" && held === undefined) { held = m.id; requested(); return; }
      if (m.method === "Page.navigate") ws.send(JSON.stringify({ id: held, result: { loaderId: "late-cancelled-navigation" } }));
      const result = m.method === "Target.getTargets" ? { targetInfos: [{ targetId: "fixture", type: "page", url: "about:blank", title: "Fixture" }] } : m.method === "Target.attachToTarget" ? { sessionId: "page-session" } : {};
      ws.send(JSON.stringify({ id: m.id, result }));
    } },
  });
  const service = new BrowserService({ cdpUrl: `ws://127.0.0.1:${web.port}/devtools/browser/fixture` }), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = service.navigate("http://example.invalid/", controller.signal).then(() => "loaded", (error) => String(error));
  try {
    await navigating; controller.abort();
    const result = await Promise.race([pending, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting for CDP"), 150); })]);
    expect(result).toContain("cancelled");
    await service.navigate("http://example.invalid/after-interrupt");
    expect((await service.tabs()).length).toBe(1);
  } finally { clearTimeout(timer); service.disconnect(); web.stop(true); await pending; }
});

test("late fixture cleanup cannot replace the active daemon fixture's home", () => {
  const previous = process.env.RIGWELL_HOME, old = tmpEnv(), current = tmpEnv();
  try { old.cleanup(); expect(process.env.RIGWELL_HOME).toBe(current.rigwellHome); }
  finally { current.cleanup(); if (previous === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = previous; }
});
