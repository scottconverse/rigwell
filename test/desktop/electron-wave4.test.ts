// Wave 4 (owner approved desktop features) in the real app: Electron through Playwright, a real daemon, the fake model
// server and the fake OAuth server. Dictation with a fake speech-to-text program, the secrets page, OAuth sign-in, the
// automation templates / overview / guided setup, the tray, spec handoff and Chrome cookie import (synthetic database).
// Skipped, with the reason printed, when Electron, Playwright or an X server are not available.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { startFakeOAuth, type FakeOAuth } from "../fakes/fake-oauth.ts";
import type { FakeServer, FakeTurn } from "../fakes/types.ts";
import { CLI, makeHome, makeRepo } from "../e2e/helpers.ts";
import { deriveKey } from "../../src/sidepane/chrome-cookies.ts";
import { makeCookieDb, SECRET_SESSION_VALUE } from "./cookie-fixture.ts";
import { diagnose, electronStatus, sleep, withDiagnosis } from "./helpers.ts";

const desktop = join(import.meta.dir, "../../desktop");
const { pw, electronBin, reason } = electronStatus("electron wave 4 test");
const maybe = reason ? describe.skip : describe;
setDefaultTimeout(150_000);

const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
const SECRET_VALUE = "sk-test-0123456789abcdef";

maybe("desktop app: wave 4 features", () => {
  let fake: FakeServer, idp: FakeOAuth, xvfb: ChildProcess | undefined, app: any, page: any;
  let repo: string, home: string, display: string, chromeDir: string, sttDir: string, sttProgram: string;
  let stderr = "";

  const hook = <T>(fn: string, ...args: unknown[]): Promise<T> => app.evaluate((_e: unknown, a: { fn: string; args: unknown[] }) => (globalThis as any).__rigwellTest[a.fn](...a.args), { fn, args });
  const go = async (hash: string) => { await page.evaluate((h: string) => { window.location.hash = h; }, hash); };
  const send = async (text: string) => {
    await page.locator(".composer[data-ready=true]").first().waitFor({ timeout: 30_000 });
    const ta = page.getByLabel("Message").first();
    await ta.fill(text);
    await page.locator('button[aria-label="Send"]:not([disabled])').first().waitFor({ timeout: 10_000 });
    await ta.press("Enter");
  };
  const newSession = async () => {
    await go("/?folder=" + encodeURIComponent(repo));
    await page.locator(".home .composer[data-ready=true]").waitFor({ timeout: 30_000 });
  };
  const why = (label: string, fn: () => Promise<unknown>) => withDiagnosis(page, home, () => ({ label, requests: fake.requests.length }), fn);

  beforeAll(async () => {
    spawnSync("bun", ["run", "build.ts"], { cwd: desktop, stdio: "ignore" });
    repo = makeRepo();
    idp = startFakeOAuth();
    const route: FakeTurn = (body) => {
      const last = body.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_result");
      const lastUser: string = body.messages.filter((m: any) => m.role === "user").map(textOf).filter(Boolean).at(-1) ?? "";
      if (lastUser.includes("SPEC")) return toolResult ? { text: "spec done" } : { toolCalls: [{ name: "ExitSpecMode", input: { title: "Plan H", plan: "# Plan\n1. handoff plan step" } }] };
      if (lastUser.includes("handoff plan step")) return { text: "continuing the plan" };
      if (lastUser.includes("APPROVE")) return toolResult ? { text: "ran it" } : { toolCalls: [{ name: "Execute", input: { command: "echo approved", riskLevel: "high", riskReason: "needs a look" } }] };
      if (lastUser.includes("automation")) return { text: "setup hello" };
      return { text: "hi there" };
    };
    fake = await startFakeAnthropic(Array.from({ length: 200 }, () => route));
    home = makeHome([{ provider: "anthropic", url: fake.url, displayName: "Fake Anthropic" }]);
    const settingsFile = join(home, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.oauthProviders = { acme: { clientId: "own-client", authorizationEndpoint: `${idp.url}/authorize`, tokenEndpoint: `${idp.url}/token`, deviceAuthorizationEndpoint: `${idp.url}/device`, scopes: ["models.read"] } };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    // A fake speech-to-text program and a synthetic Chrome profile.
    sttDir = join(home, "stt");
    mkdirSync(sttDir, { recursive: true });
    // Windows cannot run a #!/bin/sh script, so there the fake is a .cmd file with the same rule: text only for a non-empty file.
    sttProgram = join(sttDir, process.platform === "win32" ? "fake-stt.cmd" : "fake-stt");
    writeFileSync(sttProgram, process.platform === "win32"
      ? '@echo off\r\nfor %%A in ("%~1") do if %%~zA gtr 0 echo dictated words from the fake backend\r\n'
      : '#!/bin/sh\nif [ -s "$1" ]; then echo "dictated words from the fake backend"; fi\n');
    chmodSync(sttProgram, 0o755);
    chromeDir = join(home, "chrome");
    mkdirSync(join(chromeDir, "Default", "Network"), { recursive: true });
    writeFileSync(join(chromeDir, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } }));
    makeCookieDb(join(chromeDir, "Default", "Network", "Cookies"), deriveKey("peanuts", "linux"), true);

    // The organization sets `missions` and an autonomy ceiling: the settings pages say so.
    const orgFile = join(home, "org-settings.json");
    writeFileSync(orgFile, JSON.stringify({ managedSettings: { missions: { skipScrutiny: false }, maxAutonomyLevel: "high" } }));

    display = process.env.DISPLAY || `:${60 + Math.floor(Math.random() * 9)}`;
    if (process.platform === "linux" && !process.env.DISPLAY) {
      xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24"], { stdio: "ignore" });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>), RIGWELL_HOME: home, DISPLAY: display, RIGWELL_DAEMON_CMD: JSON.stringify(["bun", CLI]),
      RIGWELL_TEST_HOOKS: "1", RIGWELL_FAKE_AUDIO: "1", RIGWELL_CHROME_USER_DATA_DIR: chromeDir, RIGWELL_ORG_MANAGED_SETTINGS_LOCAL_PATH: orgFile,
    };
    delete env.NODE_OPTIONS;
    app = await pw._electron.launch({ executablePath: electronBin, args: ["--no-sandbox", desktop, `--route=/?folder=${encodeURIComponent(repo)}`], env, timeout: 60_000 });
    app.process().stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
    page = await app.firstWindow();
    await page.waitForSelector(".dot.running", { timeout: 40_000 });
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    xvfb?.kill();
    fake?.stop(); idp?.stop();
  });

  test("dictation: the button explains how to enable it, then a fake backend turns a recording into text", async () => {
    await page.locator(".home .composer[data-ready=true]").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    const note = page.getByRole("status", { name: "Dictation" });
    await note.waitFor({ timeout: 10_000 });
    expect(await note.textContent()).toContain("whisper.cpp");
    await note.getByRole("button", { name: "Close" }).click();

    // Configure the fake backend the way the settings page would (the desktop settings file).
    await page.evaluate((cmd: string) => (window as any).rigwell.settings.update({ dictation: { backend: "command", command: cmd } }), `${sttProgram} {file}`);
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await page.getByRole("button", { name: "Stop dictation" }).waitFor({ timeout: 15_000 });
    await sleep(1200); // a moment of (fake) microphone audio
    await page.getByRole("button", { name: "Stop dictation" }).click();
    await why("dictation text", () => page.locator(".composer-editor", { hasText: "dictated words from the fake backend" }).first().waitFor({ timeout: 30_000 }));
    // empty the box again so later tests start clean
    await page.getByLabel("Message").first().fill("");
  }, 120_000);

  test("settings pages mark org-managed settings", async () => {
    await go("/settings/missions");
    await why("missions label", () => page.getByRole("heading", { name: /^Missions/ }).locator('[data-testid="managed-by-org"]').waitFor({ timeout: 20_000 }));
    expect(await page.locator('[data-testid="managed-by-org"]').first().textContent()).toBe("[managed by org]");
    await go("/settings/session-defaults");
    await why("ceiling", () => page.getByText("Autonomy is capped at high").waitFor({ timeout: 20_000 }));
    await go("/settings/worktrees");
    await page.getByRole("heading", { name: /^Worktrees/ }).waitFor();
    expect(await page.locator('[data-testid="managed-by-org"]').count()).toBe(0); // not set by the org
  }, 60_000);

  test("secrets page: set, mask, replace and delete; the value is never shown", async () => {
    await go("/settings/api-keys");
    await page.getByRole("heading", { name: "API keys and secrets" }).waitFor();
    await page.getByLabel("Secret name").fill("MY_KEY");
    await page.getByLabel("Secret value").fill(SECRET_VALUE);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const row = page.locator('tr[data-secret="MY_KEY"]');
    await row.waitFor({ timeout: 20_000 });
    expect(await row.locator('[data-testid="secret-mask"]').textContent()).toBe("****cdef");
    expect(await page.locator("body").innerText()).not.toContain(SECRET_VALUE);
    expect(await page.getByLabel("Secret value").inputValue()).toBe(""); // the field was cleared
    expect(readFileSync(join(home, "secrets.json"), "utf8")).not.toContain(SECRET_VALUE); // the index holds the mask only

    await row.getByRole("button", { name: "Replace MY_KEY" }).click();
    await page.getByLabel("New value").fill("another-value-9876543210");
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await page.locator('tr[data-secret="MY_KEY"] [data-testid="secret-mask"]', { hasText: "****3210" }).waitFor({ timeout: 20_000 });
    expect(await page.locator("body").innerText()).not.toContain("another-value");

    await page.getByRole("button", { name: "Delete MY_KEY" }).click();
    await page.getByRole("dialog", { name: "Delete MY_KEY?" }).getByRole("button", { name: "Delete" }).click();
    await row.waitFor({ state: "detached", timeout: 20_000 });
  }, 120_000);

  test("accounts: sign in with a device code and with the browser, then sign out", async () => {
    await go("/settings/accounts");
    const row = page.locator('tr[data-provider="acme"]');
    await row.waitFor({ timeout: 20_000 });
    expect(await row.locator('[data-testid="provider-status"]').textContent()).toBe("Signed out");

    await row.getByRole("button", { name: "Sign in to acme with a code" }).click();
    await why("device code", () => page.locator('[data-testid="device-code"]').waitFor({ timeout: 20_000 }));
    expect(await page.locator('[data-testid="device-code"]').textContent()).toBe("ABCD-1234");
    await why("device flow done", () => page.locator('tr[data-provider="acme"] [data-testid="provider-status"]', { hasText: "Signed in" }).waitFor({ timeout: 40_000 }));
    expect(await page.locator("body").innerText()).not.toMatch(/access-\d|refresh-\d/); // no token reaches the page

    await row.getByRole("button", { name: "Sign out of acme" }).click();
    await page.locator('tr[data-provider="acme"] [data-testid="provider-status"]', { hasText: "Signed out" }).waitFor({ timeout: 20_000 });

    // Browser flow: the app hands the URL to the system browser (recorded by the test hook); the test plays the browser.
    await row.getByRole("button", { name: "Sign in to acme", exact: true }).click();
    await page.locator('[data-testid="login-url"]').waitFor({ timeout: 20_000 });
    await why("opened url", async () => { for (let i = 0; i < 50; i++) { if ((await hook<string[]>("opened")).length) return; await sleep(100); } throw new Error("no URL was opened"); });
    const url = (await hook<string[]>("opened")).at(-1)!;
    expect(url).toStartWith(`${idp.url}/authorize`);
    const done = await fetch(url); // follows the redirect to the daemon's loopback callback
    expect(done.status).toBe(200);
    await why("browser flow done", () => page.locator('tr[data-provider="acme"] [data-testid="provider-status"]', { hasText: "Signed in" }).waitFor({ timeout: 40_000 }));
    await row.getByRole("button", { name: "Sign out of acme" }).click();
    await page.locator('tr[data-provider="acme"] [data-testid="provider-status"]', { hasText: "Signed out" }).waitFor({ timeout: 20_000 });
  }, 150_000);

  test("automations: create from a template, view the overview page, start guided setup", async () => {
    await go("/automations");
    await page.getByRole("button", { name: "From a template" }).click();
    const picker = page.getByRole("dialog", { name: "Automation templates" });
    await picker.locator('[data-template="daily-repo-health"]').click();
    const form = page.getByRole("dialog", { name: /New automation: Daily repo health check/ });
    await form.getByLabel("Build command").fill("bun run build");
    await form.getByLabel("Project folder").fill(repo);
    expect(await form.locator('[data-testid="template-schedule"]').textContent()).toContain("every weekday at 8am");
    await form.getByText("Instructions preview").click();
    expect(await form.locator('[data-testid="template-preview"]').textContent()).toContain("Run bun run build");
    await form.getByRole("button", { name: "Create automation" }).click();

    await why("detail page", () => page.getByRole("heading", { name: "Daily repo health check" }).waitFor({ timeout: 30_000 }));
    const frame = page.frameLocator('iframe[title="Automation overview"]');
    await why("overview frame", () => frame.getByText("Daily repo health check").first().waitFor({ timeout: 30_000 }));
    expect(await page.locator('iframe[title="Automation overview"]').getAttribute("sandbox")).toBe(""); // fully sandboxed

    await go("/automations");
    await page.getByRole("button", { name: "Set up by chatting" }).click();
    const dlg = page.getByRole("dialog", { name: "Set up an automation by chatting" });
    await dlg.getByLabel("Project folder").fill(repo);
    await dlg.getByLabel("What should it do?").fill("Create an automation that checks my todos");
    await dlg.getByRole("button", { name: "Start setup" }).click();
    await why("setup session", () => page.locator(".assistant", { hasText: "setup hello" }).first().waitFor({ timeout: 40_000 }));
    expect(page.url()).toContain("#/sessions/");
    expect(await page.locator(".session-head h1").textContent()).toBe("Automation setup");
    const first = fake.requests.find((r: any) => JSON.stringify(r.tools ?? []).includes("CreateAutomation"));
    expect(first).toBeDefined();
  }, 150_000);

  test("tray: menu items, show or hide, active session count and the attention badge", async () => {
    const t0 = await hook<any>("tray");
    expect(t0.created).toBe(true);
    expect(t0.items.map((i: any) => i.label).filter(Boolean)).toEqual(["Hide Rigwell", "Active sessions: 0", "Nothing needs your attention", "Quit Rigwell"]);
    expect(t0.icon).toBe("idle");

    await hook("trayClick", "toggle");
    await why("window hidden", async () => { for (let i = 0; i < 50 && (await hook<number>("visibleWindows")) !== 0; i++) await sleep(100); });
    expect(await hook<number>("visibleWindows")).toBe(0);
    expect((await hook<any>("tray")).items[0].label).toBe("Show Rigwell");
    await hook("trayClick", "toggle");
    await why("window shown", async () => { for (let i = 0; i < 50 && (await hook<number>("visibleWindows")) !== 1; i++) await sleep(100); });
    expect((await hook<any>("tray")).items[0].label).toBe("Hide Rigwell");

    // A command that needs approval: the session is working and waits for the user.
    await newSession();
    await send("APPROVE this command");
    const panel = page.getByRole("alertdialog", { name: "Command to approve" });
    await why("approval prompt", () => panel.waitFor({ timeout: 40_000 }));
    await why("tray attention", async () => { for (let i = 0; i < 100; i++) { const t = await hook<any>("tray"); if (t.icon === "attention") return; await sleep(100); } throw new Error("tray never showed attention"); });
    const t1 = await hook<any>("tray");
    expect(t1.tooltip).toContain("1 needs your attention");
    expect(t1.items.map((i: any) => i.label)).toContain("1 request needs your attention");
    await panel.getByRole("button", { name: /Proceed once|Allow once|Approve/i }).first().click();
    await page.locator(".assistant", { hasText: "ran it" }).first().waitFor({ timeout: 40_000 });
    await why("tray idle", async () => { for (let i = 0; i < 100; i++) { const t = await hook<any>("tray"); if (t.icon === "idle") return; await sleep(100); } throw new Error("tray never went idle"); });
    expect((await hook<any>("tray")).items.map((i: any) => i.label)).toContain("Quit Rigwell");
  }, 150_000);

  test("spec handoff: the option shows the context savings and a new session continues the plan", async () => {
    await newSession();
    await page.locator(".home").getByRole("button", { name: "Normal", exact: true }).click();
    await page.locator(".home").getByRole("menuitemradio", { name: /Spec/ }).click();
    await send("SPEC write me a plan");
    const panel = page.getByRole("alertdialog", { name: "Specification for approval" });
    await why("spec panel", () => panel.waitFor({ timeout: 40_000 }));
    const handoff = panel.getByRole("button", { name: /Hand off to a new session.*% context saved/ }).first();
    await handoff.waitFor({ timeout: 10_000 });
    expect(await handoff.textContent()).toMatch(/\(\d+% context saved\)/);
    const before = page.url().split("#/sessions/")[1]?.split(/[?#]/)[0];
    await handoff.click();
    await why("new session", async () => {
      for (let i = 0; i < 300; i++) { const now = page.url().split("#/sessions/")[1]?.split(/[?#]/)[0]; if (now && now !== before) return; await sleep(100); }
      throw new Error("the new session was never opened");
    });
    await why("continued", () => page.locator(".assistant", { hasText: "continuing the plan" }).first().waitFor({ timeout: 40_000 }));
    expect(page.url().split("#/sessions/")[1]?.split(/[?#]/)[0]).not.toBe(before);
  }, 150_000);

  test("cookie import: only the chosen sites are copied into the browser pane; values are not logged", async () => {
    await page.keyboard.press("Control+Shift+B");
    await page.getByRole("button", { name: "Import cookies" }).click();
    const dlg = page.getByRole("dialog", { name: "Import cookies from Chrome" });
    await dlg.getByLabel("Chrome profile").selectOption({ label: "Chrome: Work" });
    await dlg.getByRole("button", { name: "Show sites" }).click();
    await why("sites list", () => dlg.getByText("other.org").waitFor({ timeout: 20_000 }));
    expect(await dlg.textContent()).not.toContain(SECRET_SESSION_VALUE);
    await dlg.getByLabel("Filter sites").fill("example");
    await dlg.getByRole("group", { name: "Sites" }).getByText("app.example.com").waitFor();
    expect(await dlg.getByRole("group", { name: "Sites" }).getByText("other.org").count()).toBe(0);
    for (const d of ["example.com", "app.example.com", "plain.example.com"]) await dlg.getByRole("group", { name: "Sites" }).getByLabel(new RegExp(`^${d.replace(/\./g, "\\.")}`)).check();
    await dlg.getByRole("button", { name: /^Import 3 sites/ }).click();
    if (process.platform === "win32") {
      // Windows Chrome protects cookies with DPAPI, which is not supported (decision 294): the import is refused and nothing is copied.
      await why("windows refusal", () => dlg.getByRole("alert").getByText(/not supported on Windows/).waitFor({ timeout: 30_000 }));
      const winJar = await app.evaluate(async ({ session }: any) => (await session.fromPartition("persist:browserpanel").cookies.get({})).map((c: any) => c.name));
      expect(winJar).not.toContain("sid");
      return;
    }
    await why("import summary", () => dlg.getByText(/Imported 3 cookies/).waitFor({ timeout: 30_000 }));
    expect(await dlg.textContent()).toContain("1 could not be decrypted");

    const jar = await app.evaluate(async ({ session }: any) => (await session.fromPartition("persist:browserpanel").cookies.get({})).map((c: any) => [c.name, c.value, c.domain]));
    const byName = Object.fromEntries(jar.map(([n, v]: string[]) => [n, v]));
    expect(byName.sid).toBe(SECRET_SESSION_VALUE);
    expect(byName.pref).toBe("dark");
    expect(byName.legacy).toBe("plain-value");
    expect(byName.tracker).toBeUndefined(); // other.org was not selected
    expect(byName.broken).toBeUndefined(); // could not be decrypted
    expect(stderr).not.toContain(SECRET_SESSION_VALUE);
    expect(stderr).toContain("[cookies] imported 3 cookies");
  }, 120_000);

  test("on failure the helpers still work (diagnose does not throw)", async () => {
    expect(await diagnose(page, home)).toContain("daemon stderr tail");
  });
});
