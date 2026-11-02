// Gap wave: the real desktop app (Electron through Playwright) answering the harness's requests:
// the trust dialog (rigwell.request_trust) and the ask-user panel (rigwell.ask_user). Skipped, with the reason
// printed, when Electron, Playwright or an X server are not available.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { electronStatus, sleep, withDiagnosis } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron handler test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(120_000);

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

maybe("desktop app: trust dialog and ask-user panel", () => {
  let fake: FakeServer, xvfb: ChildProcess | undefined, app: any, page: any;
  let repo: string, home: string, display: string;
  const pageLog: string[] = [];
  // What the composer looks like when a wait fails: a sent message empties it, so a stuck one shows whether Enter reached the editor.
  const composerState = async () => ({
    editorText: await page.getByLabel("Message").first().innerText().catch(() => "?"),
    sendDisabled: await page.locator('button[aria-label="Send"]').first().isDisabled().catch(() => "?"),
    pageLog: pageLog.slice(-8),
  });

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    writeFileSync(join(repo, "AGENTS.md"), "be brief\n"); // project config: the folder is worth a trust question
    const route: FakeTurn = (body) => {
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      const lastUser: string = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (lastUser.includes("ask me")) {
        if (!toolResult) return { toolCalls: [{ name: "AskUser", input: { questions: [{ topic: "Lang", question: "Which language?", options: ["ts", "py"] }] } }] };
        return { text: JSON.stringify(last.content).includes("py") ? "you chose py" : "no choice made" };
      }
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 50 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    display = process.env.DISPLAY || `:${80 + Math.floor(Math.random() * 9)}`;
    if (!process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]),
      RIGWELL_TRUST_CWD: "0", // the test setup trusts every folder; this one must ask
    };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    page.on("console", (m: any) => { if (["error", "warning"].includes(m.type())) pageLog.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on("pageerror", (e: Error) => pageLog.push(`pageerror: ${e.message.slice(0, 300)}`));
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    xvfb?.kill();
    fake?.stop();
  });

  const composerSend = async (text: string) => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    const ta = page.getByLabel("Message").first();
    await ta.fill(text);
    // Enter before the editor's state has caught up with the typed text would send nothing; the Send button turns on when it has.
    await page.locator('button[aria-label="Send"]:not([disabled])').first().waitFor({ timeout: 10_000 });
    await ta.press("Enter");
  };

  test("starting a session in an untrusted folder asks; Trust folder remembers it and the session goes on", async () => {
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
    await composerSend("hello");
    const dialog = page.getByRole("dialog", { name: "Trust this folder?" });
    await withDiagnosis(page, home, async () => ({ modelRequests: fake.requests.length, appTrustEnv: "0", ...(await composerState()) }), () => dialog.waitFor({ timeout: 30_000 }));
    expect(await dialog.textContent()).toContain(repo);
    expect(await dialog.textContent()).toContain("project settings");
    expect(fake.requests.length).toBe(0); // nothing reaches the model before the answer
    await dialog.getByRole("button", { name: "Trust folder" }).click();
    await page.locator(".assistant", { hasText: "hi there" }).first().waitFor({ timeout: 30_000 });
    expect(Object.keys(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).trustedFolders ?? {})).toEqual([repo]);
    // the instruction file was loaded because the folder is trusted now
    expect(JSON.stringify(fake.requests[0])).toContain("be brief");
  });

  test("the agent's question shows as a panel and the chosen answer reaches the model", async () => {
    await composerSend("ask me something");
    const panel = page.getByRole("alertdialog", { name: "Question" });
    await withDiagnosis(page, home, async () => ({ modelRequests: fake.requests.length, ...(await composerState()) }), () => panel.waitFor({ timeout: 30_000 }));
    expect(await panel.textContent()).toContain("Which language?");
    await panel.getByRole("button", { name: "py", exact: true }).click();
    await page.locator(".assistant", { hasText: "you chose py" }).first().waitFor({ timeout: 30_000 });
  });
});
