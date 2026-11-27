// Navigation in the real app: every page by mouse and by keyboard, Back and Forward, hide sidebar, Settings search.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHome, makeRepo, CLI } from "../e2e/helpers.ts";
import { closeElectron, electronStatus, sleep } from "./helpers.ts";
import { MORE_PAGES, PALETTE_PAGES, SETTINGS_PAGES } from "../../desktop/renderer/lib/nav-pages.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron navigation test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(120_000);

maybe("navigation", () => {
  let xvfb: ChildProcess | undefined, app: any, page: any, home: string, env: Record<string, string>, repo: string;
  const hash = () => page.evaluate(() => location.hash.replace(/^#/, ""));
  const waitHash = (r: string) => page.waitForFunction((x: string) => location.hash.replace(/^#/, "") === x, r, { timeout: 10_000 });
  const launch = async () => {
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { state: "attached", timeout: 40_000 });
  };

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    home = makeHome([]);
    const display = process.env.DISPLAY || (process.platform === "linux" ? `:${80 + Math.floor(Math.random() * 9)}` : "");
    if (process.platform === "linux" && !process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    env = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    await launch();
  });

  afterAll(async () => {
    await closeElectron(app).catch(() => {});
    xvfb?.kill();
  });

  test("the sidebar is short, and More opens every other page by mouse", async () => {
    const top = page.locator(".side-top > button, .side-more > button");
    expect(await top.allInnerTexts().then((t: string[]) => t.map((x) => x.split("\n")[0].replace(/\s*Ctrl\+K/, "").trim()))).toEqual(["New Session", "Automations", "Search", "Mission Control", "More"]);
    for (const p of MORE_PAGES) {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: p.label, exact: true }).click();
      await waitHash(p.route);
      expect(await page.getByRole("menu", { name: "More pages" }).count()).toBe(0);
      await page.locator(".side-more > button.on").waitFor();
    }
  });

  test("More works by keyboard, and Esc closes it", async () => {
    const more = page.getByRole("button", { name: "More", exact: true });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: MORE_PAGES[0].label, exact: true }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(MORE_PAGES[0].label);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu", { name: "More pages" }).count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("More");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await waitHash(MORE_PAGES[1].route);
  });

  test("the palette opens every page by keyboard", async () => {
    for (const p of PALETTE_PAGES) {
      await page.keyboard.press("Control+k");
      const box = page.getByRole("dialog", { name: "Command palette" }).getByLabel("Search", { exact: true });
      await box.fill(p.palette);
      await page.getByRole("option", { name: new RegExp(`^${p.palette}`) }).first().waitFor();
      await box.press("Enter");
      await page.waitForFunction((r: string) => (location.hash.replace(/^#/, "") || "/").split("?")[0] === r, p.route, { timeout: 10_000 });
    }
    for (const p of SETTINGS_PAGES) {
      await page.keyboard.press("Control+k");
      const box = page.getByRole("dialog", { name: "Command palette" }).getByLabel("Search", { exact: true });
      await box.fill(`Settings: ${p.label}`);
      await page.getByRole("option", { name: new RegExp(`^Settings: ${p.label}`) }).first().waitFor();
      await box.press("Enter");
      await waitHash(`/settings/${p.id}`);
    }
  });

  test("Back and Forward follow the visited pages and turn off at the ends", async () => {
    const back = page.getByRole("button", { name: "Back", exact: true });
    const forward = page.getByRole("button", { name: "Forward", exact: true });
    await page.evaluate(() => { location.hash = "/wiki"; });
    await waitHash("/wiki");
    await page.evaluate(() => { location.hash = "/sync"; });
    await waitHash("/sync");
    await back.click();
    await waitHash("/wiki");
    await forward.click();
    await waitHash("/sync");
    await page.waitForFunction(() => (document.querySelector('[aria-label="Forward"]') as HTMLButtonElement).disabled);
    expect(await forward.isDisabled()).toBe(true);
    await page.reload();
    await page.waitForSelector(".dot.running", { state: "attached", timeout: 40_000 });
    expect(await hash()).toBe("/sync");
    expect(await back.isDisabled()).toBe(true);
    expect(await forward.isDisabled()).toBe(true);
  });

  test("Settings search finds pages and options, and says when nothing matches", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const box = page.getByLabel("Find a setting");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await box.waitFor();
    expect(await nav.getByRole("button").count()).toBe(23);
    expect(await nav.locator("svg.nav-icon").count()).toBe(23);
    await box.fill("dark theme");
    await nav.getByRole("button", { name: "Appearance" }).waitFor();
    expect(await nav.getByRole("button").count()).toBe(1);
    await box.press("Enter");
    await waitHash("/settings/appearance");
    await box.fill("nothing-like-this");
    await nav.getByRole("status").getByText('No settings match "nothing-like-this".').waitFor();
    await box.press("Escape");
    expect(await nav.getByRole("button").count()).toBe(23);
  });

  test("the sidebar choice survives a restart", async () => {
    await page.getByRole("button", { name: "Hide Sidebar" }).click();
    await page.getByRole("button", { name: "Show Sidebar" }).waitFor();
    expect(await page.locator(".sidebar").isVisible()).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "desktop-settings.json"), "utf8")).sidebarHidden).toBe(true);
    await closeElectron(app);
    await launch();
    await page.getByRole("button", { name: "Show Sidebar" }).waitFor({ timeout: 20_000 });
    expect(await page.locator(".sidebar").isVisible()).toBe(false);
    await page.getByRole("button", { name: "Show Sidebar" }).click();
    await page.locator(".sidebar").waitFor();
    await page.getByRole("button", { name: "Hide Sidebar" }).waitFor();
  });
});
