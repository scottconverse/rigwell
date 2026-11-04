// The app's CDP proxy, exercised without Electron: it is backed here by a headless Chromium instead of webviews.
// The daemon-side BrowserService connects to the proxy exactly as it does to the app.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { BrowserService, CdpConnection, validateCdpUrl } from "../../src/sidepane/browser.ts";
import { chromiumStatus } from "./helpers.ts";

let hasWs = true;
try { createRequire(import.meta.url)("../../desktop/node_modules/ws"); } catch { hasWs = false; }
const { pw } = chromiumStatus("CDP proxy test");
const maybe = pw && hasWs ? describe : describe.skip;

maybe("CDP proxy (spec 17.3)", () => {
  let browser: any, chrome: CdpConnection, proxy: any, web: ReturnType<typeof Bun.serve>;
  const { startCdpProxy } = hasWs ? require("../../desktop/main/cdp-proxy.ts") : ({} as any);

  beforeAll(async () => {
    web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>Proxied</title><button onclick=\"document.title='clicked'\">Press me</button>", { headers: { "content-type": "text/html" } }) });
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const cdpPort = probe.port as number;
    probe.stop(true);
    browser = await pw.chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
    await (await browser.newContext()).newPage();
    const ws = ((await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as any).webSocketDebuggerUrl;
    chrome = await CdpConnection.connect(ws);

    const sessions = new Map<string, string>();
    const sid = async (id: string) => {
      let s = sessions.get(id);
      if (!s) { s = (await chrome.send<any>("Target.attachToTarget", { targetId: id, flatten: true })).sessionId as string; sessions.set(id, s); }
      return s;
    };
    const wrap = (id: string, title = "", url = "") => ({
      id, url: () => url, title: () => title, attach() {}, detach() {},
      send: async (method: string, params: any) => chrome.send(method, params, await sid(id)),
      onEvent: (cb: any) => { const off = chrome.on((m, p, s) => { if (s && s === sessions.get(id)) cb(m, p); }); return off; },
    });
    const host = {
      targets: () => ptargets,
      createTab: async (url: string) => { const r = await chrome.send<any>("Target.createTarget", { url }); const t = wrap(r.targetId); ptargets.push(t); return t; },
      closeTab: async (id: string) => { await chrome.send("Target.closeTarget", { targetId: id }); },
      activateTab: () => {},
    };
    const ptargets: any[] = [];
    const { targetInfos } = await chrome.send<any>("Target.getTargets");
    for (const t of targetInfos.filter((x: any) => x.type === "page")) ptargets.push(wrap(t.targetId, t.title, t.url));
    proxy = await startCdpProxy({ host });
  });
  afterAll(async () => { await proxy?.stop(); chrome?.close(); await browser?.close(); web?.stop(true); });

  test("the proxy's URL passes the daemon's endpoint check and serves only its capability path", async () => {
    expect(validateCdpUrl(proxy.url, proxy.port)).toBe(proxy.url);
    const bad = await fetch(`http://127.0.0.1:${proxy.port}/devtools/browser/other`).then((r) => r.status);
    expect(bad).toBe(404);
    await expect(CdpConnection.connect(`ws://127.0.0.1:${proxy.port}/devtools/browser/guess`, 1500)).rejects.toThrow();
  });

  test("BrowserService drives a page through the proxy: tabs, navigate, snapshot, click, new tab", async () => {
    const b = new BrowserService({ cdpUrl: proxy.url });
    try {
      expect((await b.tabs()).length).toBe(1);
      await b.navigate(`http://127.0.0.1:${web.port}/`);
      const snap = await b.snapshot();
      expect(snap.title).toBe("Proxied");
      const btn = snap.items.find((i) => i.label === "Press me")!;
      await b.click(btn.ref);
      expect(await b.evaluate("document.title")).toBe("clicked");
      const id = await b.newTab(`http://127.0.0.1:${web.port}/`);
      expect((await b.tabs()).length).toBe(2);
      expect((await b.tabs()).find((t) => t.active)?.id).toBe(id);
      await b.closeTab(id);
    } finally { b.disconnect(); }
  }, 30_000);
});
