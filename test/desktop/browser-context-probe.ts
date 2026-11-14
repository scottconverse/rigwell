// Temporary fake-page diagnostic: compare a fresh context on the same owned browser/proxy.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CdpConnection, validateCdpUrl } from "../../src/sidepane/browser.ts";

export async function probeBrowserContext(home: string, target: string) {
  if (process.env.RIGWELL_BROWSER_CONTEXT_PROBE !== "1") return;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
  let c: CdpConnection | undefined, paused = 0;
  try {
    const root = join(home, "browser-profiles"), profile = readdirSync(root).find((p) => /^owned-[A-Za-z0-9_-]+$/.test(p));
    if (!profile) throw new Error("No owned fixture profile");
    const [port, path] = readFileSync(join(root, profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    c = await CdpConnection.connect(validateCdpUrl(`ws://127.0.0.1:${port}${path}`), 500);
    const send = (method: string, params = {}, sid?: string) => c!.send<any>(method, params, sid, 2500, controller.signal);
    const { browserContextId } = await send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    c.on((method, params, sid) => {
      if (method !== "Fetch.requestPaused" || sid !== sessionId) return;
      paused++;
      const allowed = String(params.request?.url).startsWith(new URL(target).origin + "/");
      void send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: params.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}) }, sid).catch(() => {});
    });
    await send("Page.enable", {}, sessionId); await send("Network.enable", {}, sessionId);
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    const result = await send("Page.navigate", { url: target }, sessionId);
    console.error("[browser alternate-context]", JSON.stringify({ paused, result }));
  } catch (error) { console.error("[browser alternate-context]", JSON.stringify({ paused, error: String(error) })); }
  finally { clearTimeout(timer); c?.close(); }
}
