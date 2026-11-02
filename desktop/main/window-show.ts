// When a new window is shown. The window is created hidden so it does not flash before its first paint.
// Electron's "ready-to-show" waits for that first paint. On Linux (seen under Xvfb with software compositing) a hidden
// window can paint nothing, so "ready-to-show" never comes and the window stays hidden: no frames, no key input.
// So the window is shown on "ready-to-show" or on the page's "did-finish-load", whichever comes first.
// The window's backgroundColor matches the theme, so showing it at load time does not flash white.

export interface ShowableWindow {
  once(event: "ready-to-show", fn: () => void): unknown;
  isDestroyed(): boolean;
  webContents: { once(event: "did-finish-load", fn: () => void): unknown };
}

/** Calls `show` once, on the first of "ready-to-show" and "did-finish-load", with the name of that event. */
export function showWhenReady(win: ShowableWindow, show: (by: "ready-to-show" | "did-finish-load") => void): void {
  let shown = false;
  const go = (by: "ready-to-show" | "did-finish-load") => () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    show(by);
  };
  win.once("ready-to-show", go("ready-to-show"));
  win.webContents.once("did-finish-load", go("did-finish-load"));
}
