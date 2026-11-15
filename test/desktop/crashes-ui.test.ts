import { expect, test } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { rendererCrashReceiver } from "../../desktop/main/bug-report.ts";
const { pw, reason } = chromiumStatus("renderer crash capture acceptance"); if (!pw) console.warn(reason);
test.skipIf(!pw)("headless actual browser errors and rejected promises reach the bounded main receiver without suppressing errors", async () => {
  const e = tmpEnv(); let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/crashes.ts")], target: "browser" }); expect(built.success).toBe(true); const js = await built.outputs[0]!.text(), receive = rendererCrashReceiver(e.rigwellHome);
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const path = new URL(req.url).pathname; if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } }); if (path === "/fixture-crash") return Response.json(receive(1, await req.json())); return new Response('<body><script type="module" src="/app.js"></script></body>', { headers: { "content-type": "text/html" } }); } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], external: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (!r.url().startsWith(`http://127.0.0.1:${web!.port}/`)) external.push(r.url()); });
    await page.goto(`http://127.0.0.1:${web.port}/`); const captured = (text: string) => page.waitForResponse((r: any) => r.url().endsWith("/fixture-crash") && r.request().postData().includes(text));
    let response = captured("uncaughtError"); await page.getByRole("button", { name: "Trigger error", exact: true }).click(); expect(await (await response).json()).toBe(true);
    response = captured("unhandledRejection"); await page.getByRole("button", { name: "Trigger rejection", exact: true }).click(); expect(await (await response).json()).toBe(true);
    const reports = readdirSync(join(e.rigwellHome, "crashes")).map((n) => JSON.parse(readFileSync(join(e.rigwellHome, "crashes", n), "utf8"))); expect(reports).toHaveLength(2); expect(reports.every((r) => r.source === "renderer")).toBe(true); expect(reports.some((r) => r.detail.includes("renderer-crash-fixture"))).toBe(true); expect(reports.some((r) => r.detail.includes("renderer-rejection-fixture"))).toBe(true); expect(errors.some((s) => s.includes("renderer-crash-fixture"))).toBe(true); expect(errors.some((s) => s.includes("renderer-rejection-fixture"))).toBe(true); expect(external).toEqual([]);
  } finally { await browser?.close(); await web?.stop(true); e.cleanup(); }
}, 15000);
