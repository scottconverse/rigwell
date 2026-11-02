// Tray model (spec 14.2): icon state, tooltip counts and menu items. The real Tray is checked in the Electron test.
import { describe, expect, test } from "bun:test";
import { trayModel } from "../../desktop/main/tray.ts";

const ids = (m: ReturnType<typeof trayModel>) => m.items.map((i) => ("id" in i ? i.id : "-"));

describe("tray model", () => {
  test("idle: show or hide follows window visibility, counts are zero", () => {
    const shown = trayModel({ visible: true, active: 0, attention: 0 });
    expect(shown.icon).toBe("idle");
    expect(shown.tooltip).toBe("Rigwell: No sessions working");
    expect(shown.items[0]).toEqual({ id: "toggle", label: "Hide Rigwell" });
    expect(trayModel({ visible: false, active: 0, attention: 0 }).items[0]).toEqual({ id: "toggle", label: "Show Rigwell" });
    expect(ids(shown)).toEqual(["toggle", "-", "active", "attention", "-", "quit"]);
  });
  test("working: icon, count and tooltip", () => {
    const m = trayModel({ visible: true, active: 2, attention: 0 });
    expect(m.icon).toBe("working");
    expect(m.tooltip).toBe("Rigwell: 2 sessions working");
    expect(m.items.find((i) => "id" in i && i.id === "active")).toMatchObject({ label: "Active sessions: 2", enabled: false });
    expect(trayModel({ visible: true, active: 1, attention: 0 }).tooltip).toBe("Rigwell: 1 session working");
  });
  test("attention badge wins over working", () => {
    const m = trayModel({ visible: false, active: 1, attention: 3 });
    expect(m.icon).toBe("attention");
    expect(m.tooltip).toBe("Rigwell: 1 session working, 3 need your attention");
    expect(m.items.find((i) => "id" in i && i.id === "attention")).toMatchObject({ label: "3 requests need your attention" });
    expect(trayModel({ visible: true, active: 0, attention: 1 }).items.find((i) => "id" in i && i.id === "attention")).toMatchObject({ label: "1 request needs your attention" });
  });
  test("Quit is always present and enabled", () => {
    for (const a of [0, 4]) expect(trayModel({ visible: true, active: a, attention: a }).items.find((i) => "id" in i && i.id === "quit")).toEqual({ id: "quit", label: "Quit Rigwell" });
  });
});
