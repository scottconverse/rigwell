import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { runEval } from "../../src/eval/runner.ts";
import { loadTasks } from "../../src/eval/tasks.ts";
import { saveRun } from "../../src/eval/store.ts";
import { listDatasets } from "../../src/eval/datasets.ts";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";
const { pw, reason } = chromiumStatus("evaluation production page acceptance");
if (!pw) console.warn(reason);

test.skipIf(!pw)("production Evaluations browses actual run evidence, compares two profiles, saves exports and confirms inert dataset import", async () => {
  const env = tmpEnv();
  let fake: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined, daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, web: ReturnType<typeof Bun.serve> | undefined, browser: any, page: any;
  try {
    fake = await startFakeAnthropic(["Left output", "Right output"].flatMap((text) => [
      { toolCalls: [{ name: "Read", input: { path: "greet.js" } }] },
      { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: '"Hello, "' } }] }, { text },
    ]));
    writeJson(join(env.rigwellHome, "settings.json"), { customModels: ["First", "Second"].map((displayName) => ({ model: "fixture", displayName, provider: "anthropic", baseUrl: fake!.url, apiKey: "fake-only" })) });
    const run = await runEval({ config: { models: [{ id: "custom:First-0" }, { id: "custom:Second-1" }], autonomy: "low" }, tasks: loadTasks(undefined, ["fix-greeting-typo"]), buildId: "ui-eval" }); expect(run.results.every((r) => r.passed)).toBe(true); saveRun(run); const requests = fake.requests.length;
    const source = join(env.root, "dataset.jsonl"); writeFileSync(source, JSON.stringify({ prompt: '<script>window.evalExecuted=true</script>', expectedOutput: "inert" }) + "\n");
    daemon = await startDaemon({ socketPath: join(env.root, "daemon.sock"), backgroundServices: false, automations: false, sidepane: false, delegation: false, ws: { port: 0 } });
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
    const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] });
    expect(bundle.success).toBe(true); const js = await bundle.outputs[0]!.text(), socket = `${daemon.wsUrl}?token=${daemon.wsToken}`;
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return new URL(req.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response(`<div id="root"></div><script>window.fixtureSocket=${JSON.stringify(socket)};</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!/^https?:\/\/127\.0\.0\.1:/.test(r.url())) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/eval`); await page.getByRole("button", { name: /^Open ui-eval / }).click(); const evidence = page.getByRole("article", { name: "Trial evidence" }); await evidence.getByText("Left output", { exact: true }).first().waitFor(); expect(await evidence.innerText()).toContain("Hello,");
    await page.getByRole("button", { name: "Inspect trial 2", exact: true }).click(); await evidence.getByText("Right output", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Use as left 1", exact: true }).click(); await page.getByRole("button", { name: "Compare right 2", exact: true }).click(); const comparison = page.getByRole("region", { name: "Side-by-side outputs" }); await comparison.waitFor(); expect(await comparison.innerText()).toContain("Left output"); expect(await comparison.innerText()).toContain("Right output");
    await page.getByRole("button", { name: "Export JSONL", exact: true }).click(); await page.getByRole("status").getByText("JSONL saved locally.", { exact: true }).waitFor(); const saved = await page.evaluate(() => (window as any).savedEval); expect(saved.format).toBe("jsonl"); expect(saved.content).toContain('"transcript"'); expect(saved.content).not.toContain("fake-only");
    await page.getByLabel("Dataset file", { exact: true }).fill(source); await page.getByLabel("Dataset format", { exact: true }).selectOption("jsonl"); await page.getByRole("button", { name: "Preview dataset", exact: true }).click(); await page.getByRole("region", { name: "Dataset preview" }).waitFor();
    await page.getByRole("button", { name: "Import dataset", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "Import local dataset?", exact: true }); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(listDatasets()).toEqual([]);
    await page.getByRole("button", { name: "Import dataset", exact: true }).click(); await dialog.getByRole("button", { name: "Save dataset", exact: true }).click(); await page.getByRole("status").getByText("Dataset saved locally. No trial started.", { exact: true }).waitFor(); await page.getByRole("button", { name: "Imported dataset (1, jsonl)", exact: true }).click(); await page.getByRole("region", { name: "Dataset contents" }).waitFor();
    expect(listDatasets()).toHaveLength(1); expect(await page.evaluate(() => (window as any).evalExecuted)).toBeUndefined(); expect(fake.requests.length).toBe(requests); expect(errors).toEqual([]); expect(external).toEqual([]);
  } catch (e) { console.error("[Eval UI]", page ? await page.locator("body").innerText().catch(() => "unavailable") : "no page"); throw e; }
  finally { await browser?.close(); web?.stop(true); await daemon?.stop(); fake?.stop(); closeSessionIndexes(); env.cleanup(); }
}, 20_000);
