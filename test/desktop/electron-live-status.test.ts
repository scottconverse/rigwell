// Live status in the real app: a fake agent job shows in the sidebar and the Agents tab, and a crash leaves nothing Working.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { closeElectron, electronStatus, sleep } from "./helpers.ts";
import { jsCommand } from "../platform.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron live status test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(180_000);
const AGENT = "Status builder with a long full name that the tab must not cut off";

maybe("live agent status", () => {
  let fake: FakeServer, xvfb: ChildProcess | undefined, app: any, page: any, repo: string, home: string, gate: string;
  const held = () => ({ toolCalls: [{ name: "Execute", input: { command: jsCommand(home, `const fs = require("fs"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log("released"); } }, 50);`), riskLevel: "low", riskReason: "waits for a file" } }] });

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    gate = join(repo, "GATE");
    const route: FakeTurn = (body) => {
      const last = JSON.stringify(body.messages.at(-1));
      if (last.includes("tool_result") && last.includes("released")) return { text: "Job finished" };
      if (last.includes("START WORKSTREAM")) return { toolCalls: [{ name: "ProposeWorkstream", input: { title: "Status team", goal: "Show status", plan: "One member" } }] };
      if (last.includes('\\"accepted\\":true')) return { toolCalls: [{ name: "SpawnAgent", input: { name: AGENT, role: "Code", prompt: "BUSY", worktree: false, autonomyLevel: "high" } }] };
      if (last.includes("BUSY") || last.includes("CRASH JOB")) return held();
      return { text: "Turn finished" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 60 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    const display = process.env.DISPLAY || (process.platform === "linux" ? `:${90 + Math.floor(Math.random() * 9)}` : "");
    if (process.platform === "linux" && !process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []), desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { state: "attached", timeout: 40_000 });
  });

  afterAll(async () => {
    if (gate) writeFileSync(gate, "go"); // a failed test must not leave the held command running
    await closeElectron(app).catch(() => {});
    xvfb?.kill();
    fake?.stop();
  });

  const send = async (text: string) => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    await page.getByLabel("Message").first().fill(text);
    await page.locator('button[aria-label="Send"]:not([disabled])').first().click();
  };

  test("a workstream member shows in the sidebar and Agents tab, then stops showing as Working", async () => {
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
    await send("START WORKSTREAM");
    const proposal = page.getByRole("alertdialog", { name: "Workstream for approval" });
    await proposal.waitFor({ timeout: 30_000 });
    await page.locator('.side-row [data-testid="session-state"]', { hasText: "Waiting for you" }).first().waitFor({ timeout: 20_000 });
    await proposal.getByRole("button", { name: "Accept workstream" }).click();

    const running = page.getByRole("region", { name: "Running workstreams" });
    await running.getByText("Status team").waitFor({ timeout: 30_000 });

    if (!(await page.getByTestId("sidepane").isVisible())) await page.getByLabel("Toggle tools panel").click();
    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    const row = page.getByRole("article", { name: AGENT });
    await row.waitFor({ timeout: 30_000 });
    await row.getByText("Working", { exact: true }).waitFor({ timeout: 30_000 });
    await row.getByText(/Running Execute/).waitFor({ timeout: 30_000 });
    await row.getByText(/Running \d/).waitFor({ timeout: 10_000 });
    const name = row.locator(".agent-name");
    expect(await name.innerText()).toBe(AGENT);
    expect(await name.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await row.getByText("Details").click();
    await row.getByText("Tokens", { exact: true }).waitFor();

    writeFileSync(gate, "go");
    await row.getByText("Idle", { exact: true }).waitFor({ timeout: 40_000 });
    expect(await row.getByText(/Running Execute/).count()).toBe(0);
  });

  test("a crashed background service leaves no session Working", async () => {
    rmSync(gate, { force: true });
    await page.locator('button[aria-label="Send"]').first().waitFor({ timeout: 30_000 });
    await send("CRASH JOB");
    const working = page.locator('.side-row [data-testid="session-state"]', { hasText: "Working" });
    await working.first().waitFor({ timeout: 30_000 });
    const info = await page.evaluate(() => (window as any).rigwell.app.info());
    process.kill(info.daemon.pid, "SIGKILL");
    await page.waitForFunction(() => !document.querySelector('.side-row [data-testid="session-state"].working'), undefined, { timeout: 30_000 });
    await page.waitForSelector(".dot.running", { state: "attached", timeout: 40_000 });
    await sleep(1500);
    expect(await working.count()).toBe(0);
  });
});
