import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumStatus } from "./helpers.ts";

const { pw, reason } = chromiumStatus("side-chat headless UI");
(reason ? test.skip : test)("side-chat writes checkbox shows pending intent, waits for acknowledgement and rolls back errors", async () => {
  const require = createRequire(join(import.meta.dir, "../../desktop/package.json"));
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/side-chat.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(build) {
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) }));
  } }] });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new URL(r.url).pathname === "/app.js" ? new Response(js, { headers: { "content-type": "application/javascript" } }) : new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } }) });
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const checkbox = page.getByLabel("Allow edits in this side chat");
    await checkbox.check();
    expect(await checkbox.isChecked()).toBe(true); expect(await checkbox.isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).fixture.writes)).toBe(false);
    await page.evaluate(() => (window as any).fixture.settle(true));
    await page.getByRole("alert").filter({ hasText: "Fixture refused" }).waitFor();
    expect(await checkbox.isChecked()).toBe(false); expect(await checkbox.isEnabled()).toBe(true);
    await checkbox.check();
    await page.evaluate(() => (window as any).fixture.settle(false));
    await page.waitForFunction(() => { const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement; return input.checked && !input.disabled; });
    expect(await page.evaluate(() => (window as any).fixture.writes)).toBe(true);
    await checkbox.uncheck();
    expect(await checkbox.isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).fixture.writes)).toBe(true);
    await page.evaluate(() => (window as any).fixture.settle(false));
    await page.waitForFunction(() => { const input = document.querySelector('input[type="checkbox"]') as HTMLInputElement; return !input.checked && !input.disabled; });
    expect(await page.evaluate(() => (window as any).fixture.requests)).toEqual([true, true, false]);
    await page.getByRole("button", { name: "Contextual side chat" }).click();
    const question = page.getByLabel("Side question");
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Side question"]') as HTMLTextAreaElement)?.value === 'About this: "you chose rust and zig"\n\n');
    await question.fill("SIDEQ what is going on?");
    expect(await question.inputValue()).toBe("SIDEQ what is going on?");
    await question.press("Enter");
    expect(await page.evaluate(() => (window as any).fixture.questions)).toEqual(["SIDEQ what is going on?"]);
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
