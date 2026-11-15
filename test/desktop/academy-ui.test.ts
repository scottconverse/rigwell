import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { LESSONS } from "../../src/academy/catalog.ts";
import { listPractice, removePractice } from "../../src/academy/practice.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
const { pw, reason } = chromiumStatus("academy production page acceptance");
if (!pw) console.warn(reason);

test.skipIf(!pw)("production Academy stays offline, saves/checks/resumes samples, creates an actual worktree and confirms only owned cleanup", async () => {
  const env = tmpEnv(), owned: string[] = [];
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  try {
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^https?:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/academy`); const nav = page.getByRole("navigation", { name: "Academy lessons" }); await nav.getByRole("button", { name: "Automations", exact: true }).waitFor(); expect(await nav.getByRole("button").count()).toBe(9);
    await nav.getByRole("button", { name: "Skills", exact: true }).click(); await page.getByRole("button", { name: "Start new practice", exact: true }).click(); const active = page.getByRole("region", { name: "Active practice" }); await active.waitFor();
    const root = await active.locator("code").first().innerText(), first = listPractice().find((p) => p.root === root)!; owned.push(first.id);
    await page.getByRole("button", { name: "Check practice", exact: true }).click(); await page.getByRole("status").getByText(/Needs changes/).waitFor();
    await page.getByLabel("Practice file", { exact: true }).fill(LESSONS.find((l) => l.id === "skills")!.example); await page.getByRole("button", { name: "Check practice", exact: true }).click(); await page.getByRole("status").getByText(/Practice passed/).waitFor();
    expect(readFileSync(join(root, ".rigwell/skills/academy-example/SKILL.md"), "utf8")).toContain("Inspect a small sample change");
    await page.reload(); await page.getByRole("button", { name: `Resume ${first.id}`, exact: true }).click(); await active.waitFor(); expect(await page.getByLabel("Practice file", { exact: true }).inputValue()).toContain("Inspect a small sample change");
    await nav.getByRole("button", { name: "Worktrees", exact: true }).click(); await page.getByRole("button", { name: "Start new practice", exact: true }).click(); await active.waitFor();
    const secondRoot = await active.locator("code").first().innerText(), second = listPractice().find((p) => p.root === secondRoot)!; owned.push(second.id);
    await page.getByRole("button", { name: "Create practice worktree", exact: true }).click(); await page.getByRole("status").getByText(/Created academy-practice/).waitFor(); expect(existsSync(join(secondRoot, ".practice-worktrees/lesson/.git"))).toBe(true);
    await page.getByLabel("Practice file", { exact: true }).fill(LESSONS.find((l) => l.id === "worktrees")!.example); await page.getByRole("button", { name: "Check practice", exact: true }).click(); await page.getByRole("status").getByText(/Practice passed/).waitFor();
    await page.getByRole("button", { name: "Open sample session", exact: true }).click(); expect(await page.evaluate(() => (window as any).fixtureRoute)).toBe(`/?folder=${encodeURIComponent(secondRoot)}`);
    await page.getByRole("button", { name: "Remove active practice", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Remove sample repository?", exact: true }); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(existsSync(secondRoot)).toBe(true);
    await page.getByRole("button", { name: "Remove active practice", exact: true }).click(); await dialog.getByRole("button", { name: "Remove sample", exact: true }).click(); await page.waitForFunction((id: string) => ![...document.querySelectorAll("button")].some((b) => b.textContent === `Resume ${id}`), second.id); expect(existsSync(secondRoot)).toBe(false); expect(existsSync(root)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(existsSync(join(env.rigwellHome, "settings.json"))).toBe(false);
  } catch (e) { console.error("[Academy UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); closeSessionIndexes(); for (const id of owned) { if (listPractice().some((p) => p.id === id)) removePractice(id, true); } env.cleanup(); }
}, 20_000);
