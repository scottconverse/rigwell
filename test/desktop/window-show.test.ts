// A new window is shown on its first paint or when its page has loaded, whichever comes first (decision 320).
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { showWhenReady } from "../../desktop/main/window-show.ts";

function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & { destroyed: boolean; isDestroyed(): boolean; webContents: EventEmitter };
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.webContents = new EventEmitter();
  return win;
}

describe("showWhenReady", () => {
  test("shows on did-finish-load when ready-to-show never comes (a hidden window that paints nothing)", () => {
    const win = fakeWindow();
    const shown: string[] = [];
    showWhenReady(win as any, (by) => shown.push(by));
    win.webContents.emit("did-finish-load");
    expect(shown).toEqual(["did-finish-load"]);
  });

  test("shows once on ready-to-show; a later load does not show it again", () => {
    const win = fakeWindow();
    const shown: string[] = [];
    showWhenReady(win as any, (by) => shown.push(by));
    win.emit("ready-to-show");
    win.webContents.emit("did-finish-load");
    expect(shown).toEqual(["ready-to-show"]);
  });

  test("does nothing for a window closed before it was ready", () => {
    const win = fakeWindow();
    const shown: string[] = [];
    showWhenReady(win as any, (by) => shown.push(by));
    win.destroyed = true;
    win.webContents.emit("did-finish-load");
    win.emit("ready-to-show");
    expect(shown).toEqual([]);
  });
});
