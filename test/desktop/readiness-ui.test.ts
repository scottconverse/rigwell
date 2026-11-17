import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { generateReadinessReport } from "../../src/missions/readiness-report.ts";
import { execFileSync } from "node:child_process";
const { pw, reason } = chromiumStatus("mission readiness production acceptance"); if (!pw) console.warn(reason);

test.skipIf(!pw)("actual session warning reads local readiness evidence, prepares without sending or replacing a draft, and can continue", async () => {
  const e = tmpEnv(), fake = await startFakeAnthropic([]); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    execFileSync("git", ["init"], { cwd: e.root, stdio: "ignore" }); execFileSync("git", ["remote", "add", "origin", "https://example.invalid/fixture.git"], { cwd: e.root, stdio: "ignore" }); writeFileSync(join(e.root, "file.txt"), "fixture");
    writeJson(join(e.rigwellHome, "settings.json"), { customModels: [{ displayName: "Fixture", model: "fixture", provider: "anthropic", baseUrl: fake.url, apiKey: "fake-only" }], trustedFolders: [e.root] });
    daemon = await startDaemon({ socketPath: join(e.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] }); expect(built.success).toBe(true);
    const js = await built.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { if (new URL(req.url).pathname === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } }); return new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};window.fixtureFolder=${JSON.stringify(e.root)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${web.port}/readiness`); const editor = page.getByRole("textbox", { name: "Message", exact: true }); await editor.fill("Preserve this draft.");
    const open = async () => { await page.getByRole("button", { name: "Normal", exact: true }).click(); await page.getByRole("menu", { name: "Mode", exact: true }).getByRole("menuitemradio", { name: /Mission/ }).click(); };
    await open(); const dialog = page.getByRole("dialog", { name: "This folder is not ready for a mission", exact: true }); await dialog.getByText(/Build and tests have not been checked here/).waitFor(); expect(fake.requests).toHaveLength(0);
    await dialog.getByRole("button", { name: "Prepare readiness checks", exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="Message"]')?.textContent?.includes("readiness-report skill")); expect(await editor.innerText()).toContain("Preserve this draft."); expect(fake.requests).toHaveLength(0);
    await generateReadinessReport(e.root, { buildCommand: 'bun -e "process.exit(7)"' }, { cwd: e.root, sessionId: "ui-fixture", readFiles: new Map(), signal: new AbortController().signal });
    await open(); await dialog.getByText("build: failed", { exact: false }).waitFor(); await dialog.getByText("tests: not_checked", { exact: true }).waitFor(); expect(fake.requests).toHaveLength(0);
    await dialog.getByRole("button", { name: "Continue anyway", exact: true }).click(); await page.getByRole("button", { name: "Mission", exact: true }).waitFor(); expect(fake.requests).toHaveLength(0); expect(errors).toEqual([]);
  } finally { await browser?.close(); await web?.stop(true); await daemon?.stop(); fake.stop(); e.cleanup(); }
}, 20000);
