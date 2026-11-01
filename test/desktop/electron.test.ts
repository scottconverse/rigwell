// End-to-end smoke test of the real desktop app: Electron driven through Playwright, a real daemon child process,
// the fake model server. It walks the Phase 8 done-when list from the UI. Skipped (with the reason printed) when
// Electron, Playwright or an X server are not available.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { sleep } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const electronBin = join(desktop, "node_modules/electron/dist/electron");
let pw: any = null;
for (const base of ["/opt/node-tools/", process.cwd() + "/"]) { try { pw = createRequire(base)("playwright"); break; } catch {} }
const haveXvfb = !!Bun.which("Xvfb");
const reason = !pw ? "playwright not installed" : !existsSync(electronBin) ? "electron binary not installed (npm install in desktop/)" : !haveXvfb && !process.env.DISPLAY ? "no X server (Xvfb)" : "";
if (reason) console.log(`[electron smoke test skipped: ${reason}]`);
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(120_000);

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

maybe("desktop app end to end", () => {
  let fake: FakeServer, web: ReturnType<typeof Bun.serve>, xvfb: ChildProcess | undefined, app: any, page: any;
  let repo: string, home: string, display: string, gate: string;
  const webHits: string[] = [];
  const sideBodies: any[] = [];

  async function launch() {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
  }

  const composerSend = async (text: string) => {
    const ta = page.getByLabel("Message").first();
    await ta.fill(text);
    await ta.press("Enter");
  };
  const daemonPid = () => JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).pid as number;

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    gate = join(repo, "GATE");
    web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => { webHits.push(new URL(r.url).pathname); return new Response("<title>Tasks</title><h1>Task list</h1><button>Add task</button>", { headers: { "content-type": "text/html" } }); } });
    const route: FakeTurn = (body) => {
      const all = JSON.stringify(body.messages);
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      const userTexts = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean);
      const lastUser: string = userTexts.at(-1) ?? "";
      if (all.includes("This is a side conversation")) { sideBodies.push(body); return { text: "side answer: the agent is waiting on a gate file" }; }
      if (lastUser.includes("browse")) return toolResult ? { text: "browser done" } : { toolCalls: [{ name: "Browser", input: { action: "navigate", url: `http://127.0.0.1:${web.port}/` } }] };
      if (lastUser.includes("LONG")) return toolResult ? { text: "long finished" } : { toolCalls: [{ name: "Execute", input: { command: `while [ ! -f ${gate} ]; do sleep 0.05; done; echo released`, riskLevel: "low", riskReason: "waits for a file" } }] };
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 200 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    mkdirSync(home, { recursive: true });
    // Start with the dark theme saved, to check the very first frame later.
    display = process.env.DISPLAY || `:${90 + Math.floor(Math.random() * 9)}`;
    if (!process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    await launch();
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    xvfb?.kill();
    fake?.stop(); web?.stop(true);
  });

  test("run a session, then browse and edit a file with a stale write refused", async () => {
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
    await composerSend("hello");
    await page.locator(".assistant", { hasText: "hi there" }).first().waitFor({ timeout: 30_000 });
    expect(page.url()).toContain("#/sessions/");

    await page.keyboard.press("Control+p");
    await page.locator(".tree-row", { hasText: "greet.js" }).click();
    await page.locator(".code").getByText("Helo").first().waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Edit file").fill('export function greet(name) {\n  return "Hello, " + name + "!";\n}\n');
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved").waitFor();
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain('"Hello, "');

    // The file changes behind the editor's back: the next save is refused and the disk keeps the other writer's text.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Edit file").fill("my stale edit\n");
    writeFileSync(join(repo, "greet.js"), "changed by someone else\n");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").getByText("changed on disk").waitFor();
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toBe("changed by someone else\n");
  }, 90_000);

  test("a terminal survives a window reload", async () => {
    await page.keyboard.press("Control+j");
    const term = page.locator(".terminal .xterm").first();
    await term.waitFor();
    await term.click();
    await page.keyboard.type("echo persisted-$((40+2))\n");
    await page.locator(".xterm-rows", { hasText: "persisted-42" }).first().waitFor({ timeout: 15_000 });

    await page.reload();
    await page.waitForSelector(".dot.running", { timeout: 20_000 });
    await page.getByLabel("Message").first().waitFor({ timeout: 20_000 });
    await page.keyboard.press("Control+j");
    // The old output comes back from the daemon's scrollback, and it is the same live shell.
    await page.locator(".xterm-rows", { hasText: "persisted-42" }).first().waitFor({ timeout: 15_000 });
    await page.locator(".terminal .xterm").first().click();
    await page.keyboard.type("echo alive-$((1+1))\n");
    await page.locator(".xterm-rows", { hasText: "alive-2" }).first().waitFor({ timeout: 15_000 });
  }, 90_000);

  test("the agent drives the browser pane", async () => {
    await composerSend("please browse the page");
    await page.locator(".tool-name", { hasText: "Browser" }).first().waitFor({ timeout: 30_000 });
    await page.locator(".assistant", { hasText: "browser done" }).first().waitFor({ timeout: 30_000 });
    expect(webHits).toContain("/");
    const titles: string[] = await app.evaluate(({ webContents }: any) => webContents.getAllWebContents().filter((w: any) => w.getType() === "webview").map((w: any) => w.getTitle()));
    expect(titles).toContain("Tasks");
  }, 90_000);

  test("a side chat question is answered while the main agent works", async () => {
    await composerSend("LONG running task");
    await page.locator(".tool.running", { hasText: "Execute" }).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Control+Alt+s");
    await page.getByLabel("Side question").fill("what is it doing?");
    await page.getByLabel("Side question").press("Enter");
    await page.getByTestId("sidechat-list").getByText("side answer").waitFor({ timeout: 30_000 });
    // The main turn is still blocked on its tool.
    expect(await page.locator(".tool.running", { hasText: "Execute" }).count()).toBeGreaterThan(0);
    expect(sideBodies.length).toBeGreaterThan(0);
    writeFileSync(gate, "go");
    await page.locator(".assistant", { hasText: "long finished" }).first().waitFor({ timeout: 30_000 });
  }, 90_000);

  test("killing the daemon restarts it and the session reconnects", async () => {
    const before = daemonPid();
    process.kill(before, "SIGKILL");
    for (let i = 0; i < 200; i++) { await sleep(100); try { if (daemonPid() !== before) break; } catch {} }
    expect(daemonPid()).not.toBe(before);
    await page.waitForSelector(".dot.running", { timeout: 30_000 });
    const hellos = await page.locator(".assistant", { hasText: "hi there" }).count();
    await composerSend("hello again");
    await page.waitForFunction((n: number) => document.querySelectorAll(".assistant").length > 0 && [...document.querySelectorAll(".assistant")].filter((e) => e.textContent?.includes("hi there")).length > n, hellos, { timeout: 40_000 });
  }, 90_000);

  test("switching theme shows no flash, and the next launch paints in the saved theme from the first frame", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.evaluate(() => {
      const w = window as any;
      w.__seen = [] as string[];
      const root = document.documentElement;
      const sample = () => { w.__seen.push(`${root.getAttribute("data-theme")}|${getComputedStyle(root).backgroundColor}|${getComputedStyle(document.body).backgroundColor}`); w.__raf = requestAnimationFrame(sample); };
      sample();
    });
    await page.getByRole("radio", { name: "Dark" }).click();
    await sleep(600);
    const seen: string[] = await page.evaluate(() => { cancelAnimationFrame((window as any).__raf); return [...new Set((window as any).__seen as string[])]; });
    // Only two states were ever painted: the old theme and the new one. No transparent or intermediate frame.
    expect(seen.length).toBe(2);
    expect(seen[0].startsWith("light|")).toBe(true);
    expect(seen[1]).toBe("dark|rgb(22, 20, 19)|rgb(22, 20, 19)");
    expect(await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].getBackgroundColor())).toBe("#161413");

    // Relaunch: the window is created dark and the first frame is already dark.
    await app.close();
    await launch();
    const bg = await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
    expect(bg).toBe("#161413");
    const first = await page.evaluate(() => (window as any).__firstFrame);
    expect(first).toEqual({ theme: "dark", bg: "rgb(22, 20, 19)" });
  }, 120_000);
});
