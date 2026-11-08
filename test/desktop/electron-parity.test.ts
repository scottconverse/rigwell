// Local-parity features in the real desktop app (Electron through Playwright): the skills browser and Create skill,
// image thumbnails with the preview toolbar, and email draft cards. One screenshot per feature goes to SHOTS.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { electronStatus } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const SHOTS = process.env.RIGWELL_SHOTS_DIR || "C:\\Users\\scott\\AppData\\Local\\Temp\\claude\\2bd6b95515d96a53\\29aec070-01ca-4156-9f5a-267be4531a95\\scratchpad\\shots";
const { pw, electronBin, reason } = electronStatus("electron parity test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(150_000);

/** A 240x140 RGB gradient PNG, so the preview has something to show. */
function makePng(w = 240, h = 140): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 255) / w; raw[o + 1] = (y * 255) / h; raw[o + 2] = 160; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
const EMAIL = "To: ann@example.com\nCc: cy@example.com\nSubject: Lunch & learn\n\nHi Ann,\n\nNoon on Friday works.\nBest";

maybe("desktop app: local parity", () => {
  let fake: FakeServer, app: any, page: any;
  let repo: string, home: string;

  const hook = <T>(fn: string, ...args: unknown[]): Promise<T> => app.evaluate((_e: unknown, a: { fn: string; args: unknown[] }) => (globalThis as any).__rigwellTest[a.fn](...a.args), { fn, args });
  const send = async (text: string) => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    const ta = page.getByLabel("Message").first();
    await ta.fill(text);
    await ta.press("Enter");
  };

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    mkdirSync(SHOTS, { recursive: true });
    repo = makeRepo();
    const route: FakeTurn = (body) => {
      const lastUser: string = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (lastUser.includes("DRAFTMAIL")) return { text: "Here is a draft:\n\n```email\n" + EMAIL + "\n```\n\nTell me what to change." };
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 50 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), RIGWELL_HOME: home, RIGWELL_TEST_HOOKS: "1", RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]) };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
    await page.getByText("Fake Anthropic").first().waitFor({ timeout: 20_000 });
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    fake?.stop();
  });

  test("skills: search the list, view a SKILL.md, create a user skill that shows without a restart", async () => {
    await page.getByRole("button", { name: "Skills", exact: true }).first().click();
    const dlg = page.getByRole("dialog", { name: "Skills" });
    await dlg.waitFor();
    const list = dlg.getByRole("list", { name: "Skills" });
    await list.getByRole("button", { name: /^review/ }).first().waitFor();
    // Search filters by name and description
    await dlg.getByLabel("Search skills").fill("zzz-nothing-matches");
    await dlg.getByText("No skills found").waitFor();
    await dlg.getByLabel("Search skills").fill("review");
    const names = await list.locator(".side-title").allTextContents();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n: string) => n.length > 0)).toBe(true);
    await list.getByRole("button", { name: /^review/ }).first().click();
    expect((await dlg.getByLabel("SKILL.md body").innerText()).length).toBeGreaterThan(20);
    expect(await list.getByRole("button", { name: /Built-in/ }).count()).toBeGreaterThan(0);
    await dlg.getByLabel("Search skills").fill("");

    // Create skill: validation first
    await dlg.getByRole("button", { name: "Create skill" }).click();
    const form = page.getByRole("dialog", { name: "Create skill" });
    await form.getByLabel("Skill name").fill("Bad Name");
    await form.getByRole("alert").getByText("lowercase letters").waitFor();
    expect(await form.getByRole("button", { name: "Create", exact: true }).isDisabled()).toBe(true);
    await form.getByLabel("Skill name").fill("pizza-order");
    await form.getByLabel("Skill description").fill("Orders a pizza the way the team likes it");
    await form.getByLabel("Skill instructions").fill("1. Ask for the size.\n2. Pick toppings from the team list.\n3. Confirm the total before ordering.");
    await form.getByRole("button", { name: "Create", exact: true }).click();

    // It is listed (no restart), tagged User, and the file exists in the temp home
    const row = list.getByRole("button", { name: /^pizza-order/ });
    await row.waitFor();
    expect(await row.innerText()).toContain("User");
    expect(await dlg.getByLabel("SKILL.md body").innerText()).toContain("Confirm the total");
    const file = join(home, "skills", "pizza-order", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("name: pizza-order");
    await dlg.getByLabel("Search skills").fill("pizza");
    await page.screenshot({ path: join(SHOTS, "skills.png") });

    // Creating the same name again asks before replacing
    await dlg.getByRole("button", { name: "Create skill" }).click();
    const form2 = page.getByRole("dialog", { name: "Create skill" });
    await form2.getByLabel("Skill name").fill("pizza-order");
    await form2.getByLabel("Skill description").fill("Second version");
    await form2.getByLabel("Skill instructions").fill("Replacement instructions that are long enough to be a real body.");
    await form2.getByRole("button", { name: "Create", exact: true }).click();
    await form2.getByRole("alert").getByText("already exists").waitFor();
    expect(readFileSync(file, "utf8")).toContain("Confirm the total");
    await form2.getByRole("button", { name: "Replace existing skill" }).click();
    await dlg.getByLabel("SKILL.md body").getByText("Replacement instructions").waitFor();
    expect(readFileSync(file, "utf8")).toContain("Replacement instructions");
    await dlg.getByRole("button", { name: "Close", exact: true }).click();
    await dlg.waitFor({ state: "detached" });
  }, 120_000);

  test("images: thumbnail in the composer opens a preview with zoom, fit, remove and Esc", async () => {
    const input = page.getByTestId("attach-input");
    await input.setInputFiles([{ name: "tiny.png", mimeType: "image/png", buffer: makePng() }]);
    const thumb = page.getByRole("button", { name: "Preview tiny.png" });
    await thumb.waitFor();
    await thumb.click();
    const prev = page.getByRole("dialog", { name: /Image preview/ });
    await prev.waitFor();
    const zoom = prev.getByTestId("image-zoom");
    expect(await zoom.innerText()).toBe("100%");
    await prev.getByRole("button", { name: "Zoom in" }).click();
    expect(await zoom.innerText()).toBe("125%");
    await prev.getByRole("button", { name: "Zoom out" }).click();
    await prev.getByRole("button", { name: "Zoom out" }).click();
    expect(await zoom.innerText()).toBe("80%");
    await prev.getByRole("button", { name: "Zoom in" }).click();
    await prev.getByRole("button", { name: "Rotate" }).click();
    expect(await prev.locator("img").evaluate((el: HTMLElement) => el.style.transform)).toContain("rotate(90deg)");
    await page.screenshot({ path: join(SHOTS, "image-preview.png") });
    await prev.getByRole("button", { name: "Copy image" }).click();
    await prev.getByRole("status").getByText("Copied").waitFor();
    expect(await app.evaluate(({ clipboard }: any) => !clipboard.readImage().isEmpty())).toBe(true);
    await prev.getByRole("button", { name: "Fit" }).click();
    expect(await zoom.innerText()).toBe("100%");
    await page.keyboard.press("Escape");
    await prev.waitFor({ state: "detached" });
    expect(await page.locator(".attachment", { hasText: "tiny.png" }).count()).toBe(1);

    // Remove from inside the preview
    await thumb.click();
    await prev.waitFor();
    await prev.getByRole("button", { name: "Remove attachment" }).click();
    await prev.waitFor({ state: "detached" });
    expect(await page.locator(".attachment", { hasText: "tiny.png" }).count()).toBe(0);

    // Sent images show in the transcript and open the same preview
    await input.setInputFiles([{ name: "sent.png", mimeType: "image/png", buffer: makePng() }]);
    await page.getByRole("button", { name: "Preview sent.png" }).waitFor();
    await send("here is a picture");
    const sent = page.locator(".bubble.user").getByRole("button", { name: "Preview image 1" });
    await sent.waitFor({ timeout: 30_000 });
    await sent.click();
    await prev.waitFor();
    await prev.getByRole("button", { name: "Close preview" }).click();
    await prev.waitFor({ state: "detached" });
    await page.locator(".assistant", { hasText: "hi there" }).first().waitFor({ timeout: 30_000 });
  }, 120_000);

  test("email: an email code block renders as a card with Copy and Open in mail app", async () => {
    await send("DRAFTMAIL please");
    const card = page.locator(".email-card").first();
    await card.waitFor({ timeout: 30_000 });
    const text = await card.innerText();
    expect(text).toContain("ann@example.com");
    expect(text).toContain("Lunch & learn");
    expect(text).toContain("Noon on Friday works.");
    await page.screenshot({ path: join(SHOTS, "email-card.png") });

    await card.getByRole("button", { name: "Open in mail app" }).click();
    let opened: string[] = [];
    for (let i = 0; i < 30 && !opened.length; i++) { opened = await hook<string[]>("opened"); if (!opened.length) await new Promise((r) => setTimeout(r, 100)); }
    const url = new URL(opened.at(-1)!);
    expect(url.protocol).toBe("mailto:");
    expect(decodeURIComponent(url.pathname)).toBe("ann@example.com");
    expect(url.searchParams.get("cc")).toBe("cy@example.com");
    expect(url.searchParams.get("subject")).toBe("Lunch & learn");
    expect(url.searchParams.get("body")).toBe("Hi Ann,\r\n\r\nNoon on Friday works.\r\nBest");

    await card.getByRole("button", { name: "Copy" }).click();
    await card.getByRole("button", { name: "Copied" }).waitFor();
    expect(await app.evaluate(({ clipboard }: any) => clipboard.readText())).toBe(EMAIL);
    // A normal code block still renders as code, not as a card
    expect(await page.locator(".assistant pre").count()).toBe(0);
  }, 120_000);
});
