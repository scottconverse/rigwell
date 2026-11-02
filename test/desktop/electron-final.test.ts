// Final gap wave: the real desktop app (Electron through Playwright): composer attach (picker, paste, drop), spec edit
// and comment, denial comment, ask-user "Other...", side chat Promote and the writes switch, Archive Project, and
// per-window zoom. Skipped, with the reason printed, when Electron, Playwright or an X server are not available.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { electronStatus, sleep } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron final-gap test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(150_000);

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

maybe("desktop app: final gaps", () => {
  let fake: FakeServer, xvfb: ChildProcess | undefined, app: any, page: any;
  let repo: string, home: string, display: string;

  const send = async (text: string) => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    const ta = page.getByLabel("Message").first();
    await ta.fill(text);
    await ta.press("Enter");
  };
  const newSession = async () => {
    await page.getByRole("button", { name: "New Session" }).first().click();
    await page.locator(".home").waitFor({ timeout: 10_000 });
  };
  const lastBody = () => JSON.stringify(fake.requests.at(-1));
  const allBodies = () => JSON.stringify(fake.requests);
  const transcripts = () => {
    const out: string[] = [];
    const root = join(home, "sessions");
    for (const d of readdirSync(root)) { try { for (const f of readdirSync(join(root, d))) if (f.endsWith(".jsonl")) out.push(readFileSync(join(root, d, f), "utf8")); } catch {} }
    return out.join("\n");
  };

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    const route: FakeTurn = (body) => {
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      const lastUser: string = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (JSON.stringify(body.messages).includes("This is a side conversation")) return { text: "side answer: all quiet" };
      if (lastUser.includes("ATTACH")) return { text: "got attachments" };
      if (lastUser.includes("SPEC")) {
        if (!toolResult) return { toolCalls: [{ name: "ExitSpecMode", input: { title: "Plan A", plan: "# Plan\n1. original step" } }] };
        return { text: "spec done" };
      }
      if (lastUser.includes("DENY")) return toolResult ? { text: "denied" } : { toolCalls: [{ name: "Execute", input: { command: "echo hi > denied.txt", riskLevel: "high", riskReason: "writes a file" } }] };
      if (lastUser.includes("ASKOTHER")) {
        if (!toolResult) return { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] };
        return { text: JSON.stringify(last.content).includes("rust and zig") ? "you chose rust and zig" : "no choice made" };
      }
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 200 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    mkdirSync(home, { recursive: true });
    display = process.env.DISPLAY || `:${70 + Math.floor(Math.random() * 9)}`;
    if (!process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    xvfb?.kill();
    fake?.stop();
  });

  test("attach: the file picker, paste and drop add attachments that go to the model as images[] and files[]", async () => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    const input = page.getByTestId("attach-input");
    await input.setInputFiles([
      { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("remember the milk") },
    ]);
    await page.locator(".attachment", { hasText: "shot.png" }).waitFor();
    await page.locator(".attachment", { hasText: "notes.txt" }).waitFor();

    // paste: a clipboard event that carries an image file
    await page.evaluate((b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
      document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_B64);
    await page.locator(".attachment", { hasText: "pasted.png" }).waitFor();

    // drop: a text file dropped on the composer
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped content"], "dropped.md", { type: "text/markdown" }));
      document.querySelector(".composer")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.locator(".attachment", { hasText: "dropped.md" }).waitFor();

    // a binary blob is refused and the others stay
    await input.setInputFiles([{ name: "blob.dat", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0, 0]) }]);
    await page.getByRole("alert").getByText("blob.dat is not an image").waitFor();
    expect(await page.locator(".attachment").count()).toBe(4);

    await page.getByRole("button", { name: "Remove pasted.png" }).click();
    expect(await page.locator(".attachment").count()).toBe(3);

    await send("ATTACH please look");
    await page.locator(".assistant", { hasText: "got attachments" }).first().waitFor({ timeout: 30_000 });
    const body = lastBody();
    expect(body).toContain('"type":"image"');
    expect(body).toContain(PNG_B64);
    expect(body).toContain("remember the milk");
    expect(body).toContain("dropped content");
    expect(body).toContain("dropped.md");
    expect(body).not.toContain("pasted.png");
    await page.locator(".bubble.user", { hasText: "[Attached:" }).first().waitFor();
  }, 120_000);

  test("spec mode: add guidance, edit the plan, approve; the edit and the comment reach the model", async () => {
    await newSession();
    await page.locator(".home .composer[data-ready=true]").waitFor({ timeout: 30_000 });
    await page.locator(".home").getByRole("button", { name: "Normal", exact: true }).click();
    await page.locator(".home").getByRole("menuitemradio", { name: /Spec/ }).click();
    await send("SPEC write me a plan");
    const panel = page.getByRole("alertdialog", { name: "Specification for approval" });
    await panel.waitFor({ timeout: 30_000 });
    expect(await panel.textContent()).toContain("original step");
    expect(await panel.textContent()).toContain("Will save to:");
    await panel.getByRole("button", { name: "Add guidance" }).click();
    await panel.getByLabel("Comment").fill("keep it small");
    await panel.getByRole("button", { name: "Edit the spec first" }).click();
    await panel.getByLabel("Specification").fill("# Plan\n1. edited step");
    await panel.getByRole("button", { name: "Approve the edited spec" }).click();
    await page.locator(".assistant", { hasText: "spec done" }).first().waitFor({ timeout: 30_000 });
    const body = lastBody();
    expect(body).toContain("The user edited the plan");
    expect(body).toContain("1. edited step");
    expect(body).toContain("The user added: keep it small");
    expect(transcripts()).toContain("edited step");
  }, 120_000);

  test("a denial carries the user's comment to the harness", async () => {
    await newSession();
    await send("DENY please run it");
    const panel = page.getByRole("alertdialog", { name: "Command to approve" });
    await panel.waitFor({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Add a comment" }).click();
    await panel.getByLabel("Comment").fill("use a dry run first");
    await panel.getByRole("button", { name: "No, cancel" }).click();
    await page.locator(".tool.error, .tool", { hasText: "Execute" }).first().waitFor({ timeout: 30_000 });
    for (let i = 0; i < 100 && !transcripts().includes("use a dry run first"); i++) await sleep(100);
    expect(transcripts()).toContain("use a dry run first");
    expect(existsSync(join(repo, "denied.txt"))).toBe(false);
  }, 120_000);

  test("ask-user: Other... lets the user type their own answer", async () => {
    await newSession();
    await send("ASKOTHER which language");
    const panel = page.getByRole("alertdialog", { name: "Question" });
    await panel.waitFor({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Other..." }).click();
    await panel.getByLabel("Your answer").fill("rust and zig");
    await panel.getByRole("button", { name: "Send answer" }).click();
    await page.locator(".assistant", { hasText: "you chose rust and zig" }).first().waitFor({ timeout: 30_000 });
  }, 120_000);

  test("side chat: the writes switch, and Promote makes the side chat a normal session", async () => {
    // We are on the session of the previous test.
    const before = page.url().split("#/sessions/")[1];
    await page.getByRole("button", { name: "Side chat", exact: true }).first().click();
    const ta = page.getByLabel("Side question");
    await ta.fill("SIDEQ what is going on?");
    await ta.press("Enter");
    await page.locator(".sc-entry .assistant", { hasText: "side answer: all quiet" }).waitFor({ timeout: 40_000 });

    const writes = page.getByLabel("Allow edits in this side chat");
    expect(await writes.isChecked()).toBe(false);
    await writes.check();
    expect(await writes.isChecked()).toBe(true);
    await writes.uncheck();

    const btw = join(home, "sessions", "btw");
    expect(readdirSync(btw).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Promote to session" }).click();
    await page.waitForFunction((b: string) => !location.hash.includes(b) && location.hash.includes("/sessions/"), before, { timeout: 20_000 });
    const promoted = page.url().split("#/sessions/")[1].split(/[?#]/)[0];
    expect(promoted).not.toBe(before);
    expect(readdirSync(btw).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
    await page.locator(".side-row", { hasText: "Side chat: SIDEQ what is going on?" }).first().waitFor({ timeout: 20_000 });
    await page.locator(".assistant", { hasText: "side answer: all quiet" }).first().waitFor({ timeout: 20_000 });
  }, 120_000);

  test("Archive Project archives the project's sessions from the sidebar", async () => {
    const rows = await page.locator(".side-row").count();
    expect(rows).toBeGreaterThan(2);
    await page.getByRole("button", { name: /^Menu for / }).first().click();
    await page.getByRole("menuitem", { name: "Archive Project" }).click();
    const dialog = page.getByRole("dialog", { name: /^Archive / });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Archive Project" }).click();
    await page.getByRole("status").getByText(/^Archived \d+ session/).waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll(".side-row").length === 0, null, { timeout: 20_000 });
    expect(transcripts().length).toBeGreaterThan(0);
    const settingsFiles: string[] = [];
    const root = join(home, "sessions");
    for (const d of readdirSync(root)) { try { for (const f of readdirSync(join(root, d))) if (f.endsWith(".settings.json")) settingsFiles.push(readFileSync(join(root, d, f), "utf8")); } catch {} }
    expect(settingsFiles.length).toBeGreaterThan(2);
    expect(settingsFiles.every((s) => s.includes("archivedAt"))).toBe(true);
  }, 150_000);

  test("zoom is kept per window in window-zoom.json", async () => {
    const zoomFile = join(home, "window-zoom.json");
    const click = (id: string, idx: number) => app.evaluate(({ Menu, BrowserWindow }: any, a: { id: string; idx: number }) => {
      const w = BrowserWindow.getAllWindows().sort((x: any, y: any) => x.id - y.id)[a.idx];
      Menu.getApplicationMenu().getMenuItemById(a.id).click(undefined, w);
      return w.webContents.getZoomLevel();
    }, { id, idx });
    expect(await click("zoom-in", 0)).toBe(0.5);
    expect(await click("zoom-in", 0)).toBe(1);
    expect(JSON.parse(readFileSync(zoomFile, "utf8"))).toEqual({ "0": 1 });
    // Chromium remembers zoom per URL; moving between routes must not change this window's level.
    await page.evaluate(() => { location.hash = "#/settings/general"; });
    await page.waitForFunction(() => location.hash.includes("/settings/general"));
    await sleep(300);
    expect(await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().sort((x: any, y: any) => x.id - y.id)[0].webContents.getZoomLevel())).toBe(1);

    await app.evaluate(({ Menu }: any) => { Menu.getApplicationMenu().items.find((i: any) => i.label === "File").submenu.items.find((i: any) => i.label === "New Window").click(); });
    for (let i = 0; i < 100 && (await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().length)) < 2; i++) await sleep(100);
    for (let i = 0; i < 200 && (await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().some((w: any) => w.webContents.isLoading()))); i++) await sleep(100);
    expect(await click("zoom-out", 1)).toBe(-0.5);
    expect(JSON.parse(readFileSync(zoomFile, "utf8"))).toEqual({ "0": 1, "1": -0.5 });
    const levels = await app.evaluate(({ BrowserWindow }: any) => BrowserWindow.getAllWindows().sort((x: any, y: any) => x.id - y.id).map((w: any) => w.webContents.getZoomLevel()));
    expect(levels).toEqual([1, -0.5]);
    expect(await click("zoom-reset", 0)).toBe(0);
    expect(JSON.parse(readFileSync(zoomFile, "utf8"))["0"]).toBe(0);
  }, 90_000);
});
