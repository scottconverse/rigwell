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
import { electronStatus, sleep } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron smoke test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(120_000);
/** Waits on real readiness signals get a generous ceiling: a loaded machine slows app, daemon and polls alike. */
const LOAD_WAIT = 90_000;

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

maybe("desktop app end to end", () => {
  let fake: FakeServer, web: ReturnType<typeof Bun.serve>, xvfb: ChildProcess | undefined, app: any, page: any;
  let repo: string, home: string, display: string, gate: string;
  const webHits: string[] = [];
  let firstSession = "";
  const sideBodies: any[] = [];

  async function launch() {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
  }

  const composerSend = async (text: string) => {
    // The composer ignores Enter until the session is connected; wait for it so the message cannot be lost.
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
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
      if (lastUser.includes("RICH")) return { text: "Rich reply\n\n```ts\nconst answer: number = 42;\n```\n\nEuler: $e^{i\\pi}+1=0$ and\n\n$$\\frac{a}{b}$$\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n" };
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
    firstSession = page.url().split("#/sessions/")[1].split(/[?#]/)[0];

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
    await page.locator(".tool-name", { hasText: "Browser" }).first().waitFor({ timeout: LOAD_WAIT });
    await page.locator(".assistant", { hasText: "browser done" }).first().waitFor({ timeout: LOAD_WAIT });
    expect(webHits).toContain("/");
    // The webview title arrives after the tool result under load: poll for it instead of reading it once.
    const readTitles = (): Promise<string[]> => app.evaluate(({ webContents }: any) => webContents.getAllWebContents().filter((w: any) => w.getType() === "webview").map((w: any) => w.getTitle()));
    let titles: string[] = [];
    for (let i = 0; i < 300; i++) { titles = await readTitles(); if (titles.includes("Tasks")) break; await sleep(200); }
    if (!titles.includes("Tasks")) {
      const info = await app.evaluate(async ({ webContents }: any) => Promise.all(webContents.getAllWebContents().filter((w: any) => w.getType() === "webview").map(async (w: any) => ({ url: w.getURL(), title: w.getTitle(), loading: w.isLoading(), html: await w.executeJavaScript("document.documentElement.outerHTML.slice(0,300)").catch((e: any) => String(e)) }))));
      console.error("[browser pane diagnostics]", JSON.stringify({ info, webHits }));
    }
    expect(titles).toContain("Tasks");
  }, 240_000);

  test("markdown renders shiki code, KaTeX math and a mermaid diagram", async () => {
    await composerSend("RICH please");
    const reply = page.locator(".assistant", { hasText: "Rich reply" }).first();
    await reply.waitFor({ timeout: LOAD_WAIT });
    await reply.locator("pre.shiki").first().waitFor({ timeout: LOAD_WAIT });
    expect(await reply.locator("pre.shiki span[style*='--shiki-light']").count()).toBeGreaterThan(3);
    await reply.locator(".math .katex").first().waitFor({ timeout: LOAD_WAIT });
    await reply.locator(".math-block .katex").first().waitFor({ timeout: LOAD_WAIT });
    await reply.locator(".mermaid-diagram svg").first().waitFor({ timeout: LOAD_WAIT });
    expect(await reply.locator(".mermaid-diagram svg").first().innerHTML()).toContain("Start");
  }, 240_000);

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
    for (let i = 0; i < 500; i++) { await sleep(100); try { if (daemonPid() !== before) break; } catch {} } // a starved CI box restarts slowly
    expect(daemonPid()).not.toBe(before);
    await page.waitForSelector(".dot.running", { timeout: 30_000 });
    const hellos = await page.locator(".assistant", { hasText: "hi there" }).count();
    await composerSend("hello again");
    await page.waitForFunction((n: number) => document.querySelectorAll(".assistant").length > 0 && [...document.querySelectorAll(".assistant")].filter((e) => e.textContent?.includes("hi there")).length > n, hellos, { timeout: 40_000 });
  }, 150_000);

  test("Automations: create one, run it now, and see the run; the quit warning shows", async () => {
    await page.getByRole("button", { name: "Automations" }).click();
    await page.getByRole("heading", { name: "Automations" }).waitFor();
    await page.getByRole("button", { name: "New automation" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Nightly check");
    await page.getByLabel("Instructions").fill("Say hello and stop.");
    await page.getByLabel("Project folder").fill(repo);
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    // The detail page opens after creation.
    await page.getByRole("heading", { name: "Nightly check" }).waitFor({ timeout: 20_000 });
    await page.getByTestId("quit-warning").waitFor();
    await page.getByRole("button", { name: "Run now" }).first().click();
    await page.getByRole("table", { name: "Recent runs" }).getByText(/success|in progress/).first().waitFor({ timeout: 40_000 });
    await page.getByRole("table", { name: "Recent runs" }).getByRole("button", { name: "Open session" }).first().waitFor({ timeout: 40_000 });
    // Pause moves it to the Paused tab.
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByTestId("automation-status").getByText("Paused").waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Back to Automations" }).click();
    await page.getByRole("tab", { name: /^Paused/ }).click();
    await page.getByRole("button", { name: "Nightly check", exact: true }).waitFor();
    // Resume it, so it counts as active again, then dismiss the quit warning: the choice is stored in the desktop settings.
    await page.getByRole("button", { name: "Resume Nightly check" }).click();
    await page.getByRole("tab", { name: /^Active/ }).click();
    await page.getByTestId("quit-warning").getByRole("button", { name: "Don't show again" }).click();
    await page.getByTestId("quit-warning").waitFor({ state: "detached" });
    expect(JSON.parse(readFileSync(join(home, "desktop-settings.json"), "utf8")).automationQuitWarningDismissed).toBe(true);
  }, 120_000);

  test("Mission Control lists a mission and shows a running one with its features", async () => {
    // A stored session to hang the mission on: the one created in the first test.
    expect(firstSession).toBeTruthy();
    const dir = join(home, "missions", firstSession);
    mkdirSync(dir, { recursive: true });
    const state = (s: string) => JSON.stringify({ missionId: "mis_00000001", state: s, workingDirectory: repo, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastReviewedHandoffCount: 0, initialFeatureCount: 2, featureRetryBudgetBonus: {} });
    const features = (running: boolean) => JSON.stringify({ features: [
      { id: "api-1", description: "Add the health endpoint", skillName: "w", milestone: "m1", status: "completed", workerSessionIds: ["worker-aaaa1111"] },
      { id: "ui-2", description: "Show the status", skillName: "w", milestone: "m1", status: running ? "in_progress" : "pending", workerSessionIds: running ? ["worker-bbbb2222"] : [], ...(running ? { currentWorkerSessionId: "worker-bbbb2222" } : {}) },
    ] });
    writeFileSync(join(dir, "mission.md"), "# Build the status page\n\nA fake mission.\n");
    writeFileSync(join(dir, "state.json"), state("paused"));
    writeFileSync(join(dir, "features.json"), features(false));
    await page.getByRole("button", { name: "Mission Control" }).click();
    await page.getByRole("heading", { name: "Mission Control" }).waitFor({ timeout: LOAD_WAIT });
    await page.getByRole("tab", { name: /^Paused/ }).click();
    await page.getByTestId("mission-list").getByText("Build the status page").waitFor({ timeout: LOAD_WAIT });
    await page.getByTestId("mission-list").getByText("Build the status page").click();
    await page.getByTestId("mission-state").getByText("Paused").waitFor({ timeout: LOAD_WAIT });
    // The runner (a fake: the files) moves the mission to running; the page follows without a reload.
    writeFileSync(join(dir, "features.json"), features(true));
    writeFileSync(join(dir, "state.json"), state("running"));
    await page.getByTestId("mission-state").getByText("Running").waitFor({ timeout: LOAD_WAIT });
    await page.getByRole("table", { name: "Features" }).getByText("Show the status").waitFor({ timeout: LOAD_WAIT });
    await page.getByRole("button", { name: "Stop worker for ui-2" }).waitFor({ timeout: LOAD_WAIT });
    expect(await page.getByTestId("mission-stats").innerText()).toContain("1/2");
    writeFileSync(join(dir, "state.json"), state("paused"));
    await page.getByRole("button", { name: "Back to Mission Control" }).click();
  }, 300_000);

  test("adding a folder asks for trust and records it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "rigwell-trust-"));
    await app.evaluate(({ dialog }: any, f: string) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
    await page.getByRole("button", { name: "Add folder" }).click();
    await page.getByRole("dialog", { name: "Trust this folder?" }).waitFor();
    // Cancelling adds nothing.
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders?.[folder]).toBeUndefined();
    await page.getByRole("button", { name: "Add folder" }).click();
    await page.getByRole("button", { name: "Trust folder" }).click();
    await page.waitForFunction((f: string) => location.hash.includes(encodeURIComponent(f)), folder, { timeout: 10_000 });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders[folder]).toHaveProperty("trustedAt");
  }, 60_000);

  // Needs rigwell.rename_session / pin_session / archive_session from the harness branch; runs once that is merged.
  const harnessHasSessionMenu = /"rename_session"/.test(readFileSync(join(import.meta.dir, "../../src/daemon/connection.ts"), "utf8"));
  if (!harnessHasSessionMenu) console.log("[session header menu e2e skipped: rigwell.rename_session is not in this build yet; runs after the harness merge]");
  (harnessHasSessionMenu ? test : test.skip)("session header menu: Rename, Pin and Archive", async () => {
    await page.locator(".side-row", { hasText: "hello" }).first().click();
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Session menu" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("dialog", { name: "Rename session" }).getByLabel("Title").fill("Renamed by test");
    await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await page.locator("h1", { hasText: "Renamed by test" }).waitFor({ timeout: 15_000 });
    await page.locator(".side-title", { hasText: "Renamed by test" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Session menu" }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await page.locator(".side-row", { hasText: "Renamed by test" }).locator(".pin").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Session menu" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.locator(".side-row", { hasText: "Renamed by test" }).waitFor({ state: "detached", timeout: 15_000 });
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
