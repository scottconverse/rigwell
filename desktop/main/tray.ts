// Tray / menu-bar item (spec 14.2, owner approved): icon for idle / working / needs-you, a tooltip with the counts,
// Show or Hide, and Quit. Pure model, no Electron imports; main.ts builds the real Tray from it.
export interface TrayInput {
  /** At least one window is visible. */
  visible: boolean;
  /** Sessions whose agent is working. */
  active: number;
  /** Requests waiting for the user (permissions, questions). */
  attention: number;
}
export type TrayIcon = "idle" | "working" | "attention";
export type TrayItem = { type: "separator" } | { id: string; label: string; enabled?: boolean };
export interface TrayModel { icon: TrayIcon; tooltip: string; items: TrayItem[] }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function trayModel(i: TrayInput): TrayModel {
  const icon: TrayIcon = i.attention > 0 ? "attention" : i.active > 0 ? "working" : "idle";
  const parts = [i.active > 0 ? plural(i.active, "session working", "sessions working") : "No sessions working"];
  if (i.attention > 0) parts.push(plural(i.attention, "needs your attention", "need your attention"));
  return {
    icon,
    tooltip: `Rigwell: ${parts.join(", ")}`,
    items: [
      { id: "toggle", label: i.visible ? "Hide Rigwell" : "Show Rigwell" },
      { type: "separator" },
      { id: "active", label: `Active sessions: ${i.active}`, enabled: false },
      { id: "attention", label: i.attention > 0 ? `${plural(i.attention, "request needs", "requests need")} your attention` : "Nothing needs your attention", enabled: false },
      { type: "separator" },
      { id: "quit", label: "Quit Rigwell" },
    ],
  };
}
