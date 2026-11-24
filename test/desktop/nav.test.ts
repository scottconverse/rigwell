// Back and Forward history, and the shared page lists.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canGoBack, canGoForward, currentRoute, startHistory, stepBack, stepForward, visit } from "../../desktop/renderer/lib/nav-history.ts";
import { MORE_PAGES, PALETTE_PAGES, SETTINGS_PAGES, matchesSettings } from "../../desktop/renderer/lib/nav-pages.ts";
import { loadDesktopSettings, updateDesktopSettings } from "../../desktop/main/settings.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("navigation history", () => {
  test("a new app has nowhere to go", () => {
    const h = startHistory("/");
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
    expect(stepBack(h)).toBe(h);
    expect(stepForward(h)).toBe(h);
  });

  test("back and forward return to the same pages", () => {
    let h = visit(visit(startHistory("/"), "/wiki"), "/sync");
    h = stepBack(h);
    expect(currentRoute(h)).toBe("/wiki");
    expect(canGoForward(h)).toBe(true);
    h = stepForward(h);
    expect(currentRoute(h)).toBe("/sync");
    expect(canGoForward(h)).toBe(false);
  });

  test("the hash change after Back is not a new visit", () => {
    const h = stepBack(visit(startHistory("/"), "/wiki"));
    expect(visit(h, "/")).toBe(h);
    expect(canGoForward(h)).toBe(true);
  });

  test("a new page after Back removes the old Forward pages", () => {
    const h = visit(stepBack(visit(startHistory("/"), "/wiki")), "/sync");
    expect(h.entries).toEqual(["/", "/sync"]);
    expect(canGoForward(h)).toBe(false);
  });

  test("history has a size limit", () => {
    let h = startHistory("/0");
    for (let i = 1; i < 500; i++) h = visit(h, `/${i}`);
    expect(h.entries.length).toBe(200);
    expect(currentRoute(h)).toBe("/499");
  });
});

describe("page lists", () => {
  const app = readFileSync(join(import.meta.dir, "../../desktop/renderer/App.tsx"), "utf8");
  const settings = readFileSync(join(import.meta.dir, "../../desktop/renderer/components/Settings.tsx"), "utf8");

  test("the palette has every page the app can route to", () => {
    const routed = [...app.matchAll(/parts\[0\] === "([a-z]+)" \?/g)].map((m) => m[1]).filter((r) => r !== "settings" && r !== "sessions"); // Settings has its own list. A session route needs a session id.
    expect(routed.length).toBeGreaterThan(10);
    for (const r of routed) expect(PALETTE_PAGES.map((p) => p.route)).toContain(`/${r}`);
  });

  test("the More menu holds only pages the palette also has", () => {
    expect(MORE_PAGES.map((p) => p.id)).not.toContain("automations");
    expect(PALETTE_PAGES.map((p) => p.id)).toContain("automations");
    for (const p of MORE_PAGES) expect(PALETTE_PAGES).toContain(p);
  });

  test("all 22 Settings pages have a unique id, an icon and search words", () => {
    expect(SETTINGS_PAGES.length).toBe(22);
    expect(new Set(SETTINGS_PAGES.map((p) => p.id)).size).toBe(22);
    for (const p of SETTINGS_PAGES) { expect(p.icon).toMatch(/^M/); expect(p.words.length).toBeGreaterThan(0); }
    for (const id of ["session-defaults", "missions", "custom-models", "worktrees", "machines", "profiles", "labs", "phone-access", "delegation", "email-alerts", "connectors", "session-management", "usage", "api-keys", "environments", "accounts", "code-providers", "voice"]) {
      expect(settings).toContain(id);
      expect(SETTINGS_PAGES.map((p) => p.id)).toContain(id);
    }
  });

  test("Settings search finds a page by name and by an option", () => {
    const find = (q: string) => SETTINGS_PAGES.filter((p) => matchesSettings(p, q)).map((p) => p.id);
    expect(find("appear")).toEqual(["appearance"]);
    expect(find("THEME")).toContain("appearance");
    expect(find("dark theme")).toEqual(["appearance"]);
    expect(find("nothing-like-this")).toEqual([]);
    expect(find("  ").length).toBe(22);
  });
});

describe("sidebar setting", () => {
  test("the choice is saved, and a bad value falls back to shown", () => {
    const home = mkdtempSync(join(tmpdir(), "rigwell-nav-"));
    try {
      expect(loadDesktopSettings(home).sidebarHidden).toBe(false);
      updateDesktopSettings(home, { sidebarHidden: true });
      expect(loadDesktopSettings(home).sidebarHidden).toBe(true);
      expect(updateDesktopSettings(home, { sidebarHidden: "yes" }).sidebarHidden).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
