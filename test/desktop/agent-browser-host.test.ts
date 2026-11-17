import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdirSync, symlinkSync } from "node:fs";
import { sessionBrowserHost, BrowserRequestGuards } from "../../desktop/main/agent-browser.ts";
import { browserPolicy, resolvedBrowserPath } from "../../src/browser/policy.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";

test("a session host prefers its own pane, creates hidden fallbacks and refuses foreign targets", async () => {
  const visible: any[] = []; let closed = 0, policies = 0;
  const target = (id: string) => ({ id, url: () => "about:blank", title: () => id, attach() {}, detach() {}, async send() {}, onEvent() { return () => {}; }, async close() { closed++; } });
  const owned = sessionBrowserHost({ visible: () => visible, createHidden: async () => target("hidden"), createVisible: async () => target("new-pane"), closeVisible: async () => {}, activateVisible() {}, async setPolicy() { policies++; } });
  const other = sessionBrowserHost({ visible: () => [target("foreign")], createHidden: async () => target("other-hidden"), createVisible: async () => target("other-pane"), closeVisible: async () => {}, activateVisible() {}, async setPolicy() {} });
  try {
    expect((await owned.host.createTab("about:blank")).id).toBe("hidden"); expect(owned.host.targets().map((t) => t.id)).toEqual(["hidden"]);
    visible.push(target("pane")); expect(owned.host.targets().map((t) => t.id)).toEqual(["pane"]); expect((await owned.host.createTab("about:blank")).id).toBe("new-pane");
    await owned.host.setPolicy!({ targetId: "pane" }); expect(policies).toBe(1);
    let error: unknown; try { await owned.host.closeTab(other.host.targets()[0]!.id); } catch (e) { error = e; } expect(String(error)).toContain("another session");
  } finally { await owned.close(); await other.close(); }
  expect(closed).toBe(1);
});

test("Electron request guards enforce redirects, workers, WebSockets and download file policy without dialogs", () => {
  const env = tmpEnv(); let request: any, download: any, savePath: string | undefined, cancelled = 0;
  const ses: any = { webRequest: { onBeforeRequest(_filter: any, cb: any) { request = cb; } }, on(_event: string, cb: any) { download = cb; } };
  const wc: any = Object.assign(new EventEmitter(), { id: 77, session: ses, setWindowOpenHandler() {} });
  const guards = new BrowserRequestGuards();
  try {
    const directory = join(env.root, "downloads"); mkdirSync(directory);
    guards.install(ses, true); guards.set(wc, { allowed: ["allowed.example"], denied: ["blocked.allowed.example"], writable: [env.root], blockedPaths: [], downloadPath: directory });
    const check = (url: string, webContentsId?: number) => { let result: any; request({ url, webContentsId }, (r: any) => { result = r; }); return result.cancel; };
    expect(check("https://allowed.example/path", 77)).toBe(false);
    for (const url of ["https://blocked.allowed.example/redirect", "wss://other.example/socket", "file:///private.txt"]) { expect(check(url, 77)).toBe(true); expect(check(url)).toBe(true); }
    download({ preventDefault() { cancelled++; } }, { getFilename: () => "../../fixture.txt", setSavePath(p: string) { savePath = p; } }, wc);
    expect(savePath?.startsWith(resolvedBrowserPath(directory))).toBe(true); expect(savePath).not.toContain(".."); expect(cancelled).toBe(0);
    guards.set(wc, { allowed: ["*"], denied: [], writable: [env.root], blockedPaths: [directory], downloadPath: directory });
    download({ preventDefault() { cancelled++; } }, { getFilename: () => "blocked.txt", setSavePath() { throw new Error("must not save"); } }, wc); expect(cancelled).toBe(1);
    wc.emit("destroyed"); expect(check("https://allowed.example", 77)).toBe(true);
  } finally { env.cleanup(); }
});

test("browser output checks resolve symlinks above files that do not exist", () => {
  const env = tmpEnv();
  try {
    const outside = join(env.root, "outside"), workspace = join(env.root, "workspace"); mkdirSync(outside); mkdirSync(workspace);
    symlinkSync(outside, join(workspace, ".rigwell"), "junction");
    writeJson(join(env.rigwellHome, "settings.json"), { sandbox: { filesystem: { denyWrite: [outside] } } });
    const policy = browserPolicy("browser-link", workspace);
    expect(resolvedBrowserPath(policy.directory)).toBe(join(resolvedBrowserPath(outside), "browser/browser-link")); expect(policy.canWrite(policy.directory)).toBe(false);
  } finally { env.cleanup(); }
});
