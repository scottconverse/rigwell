// The waiting list in the real app: messages sent during a turn wait, survive a reload, and arrive in order.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { closeElectron, electronStatus, sleep } from "./helpers.ts";
import { jsCommand } from "../platform.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron waiting list test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(120_000);

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));

maybe("waiting messages", () => {
  let fake: FakeServer, xvfb: ChildProcess | undefined, app: any, page: any, repo: string, home: string, gate: string;

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    gate = join(repo, "GATE");
    const route: FakeTurn = (body) => {
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      const lastUser: string = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (lastUser.includes("LONG") && !toolResult) {
        return { toolCalls: [{ name: "Execute", input: { command: jsCommand(home, `const fs = require("fs"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log("released"); } }, 50);`), riskLevel: "low", riskReason: "waits for a file" } }] };
      }
      return { text: `reply ${body.messages.length}` };
    };
    fake = await startFakeAnthropic(Array.from({ length: 40 }, () => route));
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
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
  });

  afterAll(async () => {
    if (gate) writeFileSync(gate, "go"); // a failed test must not leave the held command running
    await closeElectron(app).catch(() => {});
    xvfb?.kill();
    fake?.stop();
  });

  test("Enter and Ctrl+Enter wait during a turn, survive a reload, and neither stops the agent", async () => {
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    await page.getByLabel("Message").first().fill("LONG job");
    await page.locator('button[aria-label="Send"]:not([disabled])').first().click();
    await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 30_000 });
    await page.locator(".tool, .activity").first().waitFor({ timeout: 30_000 });

    const input = page.getByLabel("Message").first();
    await input.fill("later message");
    await input.press("Enter");
    await page.locator(".waiting-item", { hasText: "later message" }).waitFor();
    await input.fill("steer message");
    await input.press("Control+Enter");
    await page.locator(".waiting-item", { hasText: "steer message" }).waitFor();
    expect(await page.locator(".bubble.user", { hasText: "later message" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Stop" }).count()).toBe(1);

    await page.reload();
    await page.locator(".waiting-item").nth(1).waitFor({ timeout: 30_000 });
    expect(await page.locator(".waiting-item").count()).toBe(2);

    writeFileSync(gate, "go");
    await page.locator(".bubble.user", { hasText: "later message" }).waitFor({ timeout: 40_000 });
    await page.locator(".bubble.user", { hasText: "steer message" }).waitFor({ timeout: 40_000 });
    await page.locator(".waiting").waitFor({ state: "detached", timeout: 40_000 });
    const order = await page.locator(".bubble.user").allInnerTexts();
    expect(order.map((t: string) => t.trim())).toEqual(["LONG job", "steer message", "later message"]);
  });
});
