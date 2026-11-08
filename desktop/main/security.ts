// Security helpers for the main process (spec §14.6). Pure so they can be tested without Electron.

/** Schemes the app may hand to the OS: web pages, local files and the common editors. */
export const EXTERNAL_SCHEMES = ["http:", "https:", "file:", "mailto:", "vscode:", "cursor:", "zed:", "jetbrains:", "idea:"];

export function isAllowedExternal(raw: string): boolean {
  try { return EXTERNAL_SCHEMES.includes(new URL(raw).protocol); } catch { return false; }
}

/**
 * Content Security Policy for the app pages: own files, inline styles (React style props), data: images and audio
 * (sound playback uses data URLs), and connections only to the loopback daemon and the model hosts the user configured.
 */
export function buildCsp(opts: { daemonPort?: number; modelHosts?: string[]; dev?: boolean }): string {
  const connect = ["'self'"];
  if (opts.daemonPort) connect.push(`ws://127.0.0.1:${opts.daemonPort}`, `http://127.0.0.1:${opts.daemonPort}`);
  for (const h of opts.modelHosts ?? []) { try { connect.push(new URL(h).origin); } catch {} }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The app's own page: file:// in a packaged build, or the dev URL. A sender frame must be the top frame of one of these. */
export function isTrustedSender(frameUrl: string | undefined, appUrls: string[]): boolean {
  if (!frameUrl) return false;
  return appUrls.some((u) => frameUrl === u || frameUrl.startsWith(u.endsWith("/") ? u : u + "#") || frameUrl.startsWith(u + "?"));
}

/** Local dev-server names the browser pane treats as "local" (spec §17.3). */
export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];
export const isLocalHost = (host: string) => LOCAL_HOSTS.includes(host.toLowerCase());

/** Normalizes what a user types in the browser pane's address bar. */
export function normalizeBrowserUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^(https?:|about:|file:)/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** Permissions the browser pane may be granted. Device permissions are always denied (spec §17.3). */
export function browserPermission(permission: string): "allow" | "deny" | "prompt" {
  if (["clipboard-sanitized-write", "fullscreen", "pointerLock"].includes(permission)) return "allow";
  if (["notifications", "geolocation", "clipboard-read"].includes(permission)) return "prompt";
  return "deny"; // media, midi, hid, usb, serial, bluetooth, display-capture ...
}

/** Deep link parsing: rigwell://<host><path>. `mcp-callback` is claimed by a window; anything else navigates. */
export function parseDeepLink(raw: string): { kind: "mcp-callback"; code: string; state: string } | { kind: "navigate"; route: string } | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== "rigwell:") return undefined;
  if (u.hostname === "mcp-callback") {
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    return code && state ? { kind: "mcp-callback", code, state } : undefined;
  }
  const route = `/${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  if (!/^\/[A-Za-z0-9_\-./]*$/.test(route)) return undefined;
  return { kind: "navigate", route };
}
