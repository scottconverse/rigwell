// The Update button in the real app, against a local feed. Nothing is installed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLI, makeHome } from "../e2e/helpers.ts";
import { closeElectron, electronStatus, sleep } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron update button test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(180_000);

maybe("Update button", () => {
  let xvfb: ChildProcess | undefined, app: any, page: any, feed: ReturnType<typeof Bun.serve>;
  let version = "1.0.0";

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    feed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/latest")) return Response.json({ version, files: [{ url: "update.bin", size: 4 }] });
      if (path === "/update.bin") return new Response("test");
      return new Response("Not found", { status: 404 });
    } });
    const home = makeHome([]);
    const display = process.env.DISPLAY || (process.platform === "linux" ? `:${90 + Math.floor(Math.random() * 9)}` : "");
    if (process.platform === "linux" && !process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]), RIGWELL_UPDATE_URL: feed.url.toString() };
    delete env.NODE_OPTIONS; delete env.APPIMAGE; delete env.RIGWELL_UPDATE_PUBLIC_KEY;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), desktop], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { state: "attached", timeout: 40_000 });
    // No real browser and no modal dialog in a test.
    await app.evaluate(({ shell, dialog }: any) => {
      (globalThis as any).opened = [];
      shell.openExternal = async (url: string) => { (globalThis as any).opened.push(url); };
      dialog.showMessageBox = async () => ({ response: 1 });
    });
  });

  afterAll(async () => {
    await closeElectron(app).catch(() => {});
    xvfb?.kill();
    feed?.stop(true);
  });

  const button = () => page.locator(".update-button");
  const check = () => page.evaluate(() => (window as any).rigwell.updates.check());
  const show = (state: unknown) => app.evaluate(({ BrowserWindow }: any, s: unknown) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send("updates:state", s); }, state);

  test("no update shows no button", async () => {
    version = "0.0.1";
    expect((await check()).phase).toBe("idle");
    expect(await button().count()).toBe(0);
  });

  test("a new version shows the button, and a click runs the download path", async () => {
    version = "99.0.0";
    expect((await check()).phase).toBe("available");
    await button().getByText("Update available").waitFor({ timeout: 10_000 });
    await button().click();
    if (process.platform === "linux") {
      // The feed file has no signature, so the real Linux check must refuse it.
      await button().getByText("Update refused").waitFor({ timeout: 15_000 });
      expect(await button().getAttribute("title")).toContain("try again");
    } else {
      await button().waitFor({ state: "detached", timeout: 15_000 });
      const opened = await app.evaluate(() => (globalThis as any).opened);
      expect(opened).toEqual([new URL("update.bin", feed.url).toString()]);
    }
  });

  test("the button shows each download state", async () => {
    await show({ phase: "downloading", version: "99.0.0", percent: 42 });
    await button().getByText("Downloading 42%").waitFor({ timeout: 5_000 });
    expect(await button().isDisabled()).toBe(true);
    await show({ phase: "ready", version: "99.0.0" });
    await button().getByText("Restart to install").waitFor({ timeout: 5_000 });
    expect(await button().isDisabled()).toBe(false);
    // ready state shown
    await show({ phase: "error", version: "99.0.0", message: "connection lost" });
    await button().getByText("Update failed").waitFor({ timeout: 5_000 });
    expect(await button().getAttribute("title")).toContain("connection lost");
  });
});
