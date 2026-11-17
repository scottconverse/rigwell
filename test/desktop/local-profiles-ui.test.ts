import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { chromiumStatus } from "./helpers.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { localProfileController, profileDesktopData, rememberDefaultProfileData } from "../../desktop/main/local-profiles.ts";
import { localProfileHome, readLocalProfile } from "../../src/storage/local-profiles.ts";
const { pw, reason } = chromiumStatus("local profiles production acceptance"); if (!pw) console.warn(reason);

test("desktop profile selection preserves both legacy default and explicit-home Electron data locations", () => {
  const implicit: Record<string, string | undefined> = {}; const old = join(import.meta.dir, "legacy-data"); rememberDefaultProfileData(old, implicit); expect(profileDesktopData("unused", implicit)).toBe(old);
  implicit.RIGWELL_PROFILE = "work"; const work = join(import.meta.dir, "work-data"); expect(profileDesktopData(work, implicit)).toBe(join(work, "desktop-profile")); implicit.RIGWELL_PROFILE = "default"; rememberDefaultProfileData("different", implicit); expect(profileDesktopData("unused", implicit)).toBe(old);
  const custom: Record<string, string | undefined> = { RIGWELL_HOME: work }; rememberDefaultProfileData(old, custom); expect(profileDesktopData(work, custom)).toBe(join(work, "desktop-profile"));
});

test.skipIf(!pw)("production profile page creates metadata, confirms restart and preserves the active data home until a new process", async () => {
  const env = tmpEnv(), restarts: string[][] = [], controller = localProfileController((args) => restarts.push(args), ["app", "--route=/settings/profiles"], { RIGWELL_HOME: env.rigwellHome });
  let browser: any, web: ReturnType<typeof Bun.serve> | undefined;
  try {
    const require = createRequire(join(import.meta.dir, "../../desktop/package.json")), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../desktop/renderer/test-fixtures/sharing.tsx")], target: "browser", plugins: [{ name: "desktop-react", setup(b) { b.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (a) => ({ path: require.resolve(a.path) })); } }] }); expect(built.success).toBe(true); const js = await built.outputs[0]!.text();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
      if (path === "/fixture-local-profiles" && req.method === "POST") { try { const { method, args } = await req.json(); if (!["list", "create", "update", "switch"].includes(method)) throw new Error("Unknown method"); return Response.json((controller as any)[method](...args)); } catch (e) { return new Response((e as Error).message, { status: 400 }); } }
      return new Response('<div id="root"></div><script type="module" src="/app.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    browser = await pw.chromium.launch({ headless: true }); const page = await browser.newPage(); page.setDefaultTimeout(5000); const errors: string[] = [], requests: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => requests.push(r.url()));
    await page.goto(`http://127.0.0.1:${web.port}/local-profiles`); await page.getByRole("table", { name: "Local profiles" }).getByRole("cell", { name: "default", exact: true }).waitFor();
    await page.getByLabel("Profile name", { exact: true }).fill("Home profile"); await page.getByLabel("Role", { exact: true }).fill("Reporter"); await page.getByRole("button", { name: "Save profile details", exact: true }).click(); await page.getByText("Profile details saved", { exact: true }).waitFor(); expect(readLocalProfile(env.rigwellHome, "default").role).toBe("Reporter");
    await page.getByLabel("New profile ID", { exact: true }).fill("work"); await page.getByLabel("New profile name", { exact: true }).fill("Work"); await page.getByLabel("New profile role", { exact: true }).fill("Editor"); await page.getByRole("button", { name: "Create profile", exact: true }).click(); await page.getByRole("button", { name: "Switch to work", exact: true }).waitFor();
    expect(readLocalProfile(env.rigwellHome, "work").role).toBe("Editor"); expect(existsSync(join(localProfileHome(env.rigwellHome, "work"), "settings.json"))).toBe(false); expect(restarts).toEqual([]);
    await page.getByRole("button", { name: "Switch to work", exact: true }).click(); await page.getByRole("dialog", { name: "Confirm profile switch" }).waitFor(); await page.getByRole("button", { name: "Cancel switch", exact: true }).click(); expect(restarts).toEqual([]);
    expect(() => controller.switch("work", false)).toThrow("Confirm restart"); await page.getByRole("button", { name: "Switch to work", exact: true }).click(); await page.getByRole("button", { name: "Restart and switch", exact: true }).click(); await page.getByText("Restarting with selected profile", { exact: true }).waitFor();
    expect(restarts).toEqual([["app", "--route=/settings/profiles", "--profile", "work"]]); expect(process.env.RIGWELL_HOME).toBe(env.rigwellHome); expect(readFileSync(join(env.rigwellHome, "profile.json"), "utf8")).toContain("Home profile"); expect(errors).toEqual([]); expect(requests.every((url) => /^http:\/\/127\.0\.0\.1:/.test(url))).toBe(true); expect(requests.some((url) => /fixture-settings|daemon|provider/.test(url))).toBe(false);
  } finally { await browser?.close(); await web?.stop(true); env.cleanup(); }
}, 20_000);
