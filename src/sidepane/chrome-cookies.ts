// Chrome cookie import for the browser pane (spec 17.3, owner approved). Reads a Chrome or Chromium profile's cookie
// database and decrypts the values. This only runs from an explicit user action in the desktop app; the caller chooses
// the profile and the domains, and only those cookies are returned. Values are never logged: nothing here prints them.
//
// Encryption ("v10"/"v11" prefix, AES-128-CBC, IV = 16 spaces, key = PBKDF2-HMAC-SHA1(password, "saltysalt", n, 16)):
//   Linux:  v10 uses the fixed password "peanuts"; v11 uses the "Chrome Safe Storage" secret in libsecret (secret-tool),
//           falling back to "peanuts" when no secret can be read. 1 iteration.
//   macOS:  the password is the Keychain item "Chrome Safe Storage" (Chromium: "Chromium Safe Storage"). 1003 iterations.
//   Windows: DPAPI and app-bound keys are not supported here.
// Chrome 130+ (cookie database version 24+) prepends SHA-256(host_key) to the plaintext; it is checked and removed.
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Browser = "chrome" | "chromium";
export interface ChromeProfile { browser: Browser; dir: string; name: string; path: string; cookiesFile: string }
export interface ImportedCookie {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
  /** Unix seconds; absent for a session cookie. */
  expirationDate?: number; sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}
export interface DomainCount { domain: string; count: number }

/** Where each browser keeps its profiles. */
export function userDataDirs(platform: string = process.platform, home: string = homedir(), env: Record<string, string | undefined> = process.env): { browser: Browser; dir: string }[] {
  if (platform === "darwin") return [
    { browser: "chrome", dir: join(home, "Library/Application Support/Google/Chrome") },
    { browser: "chromium", dir: join(home, "Library/Application Support/Chromium") },
  ];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData/Local");
    return [{ browser: "chrome", dir: join(local, "Google/Chrome/User Data") }, { browser: "chromium", dir: join(local, "Chromium/User Data") }];
  }
  const cfg = env.XDG_CONFIG_HOME || join(home, ".config");
  return [{ browser: "chrome", dir: join(cfg, "google-chrome") }, { browser: "chromium", dir: join(cfg, "chromium") }];
}

const cookiesFileIn = (profileDir: string): string | undefined => [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")].find((p) => existsSync(p));

/** Profiles that have a cookie database. `roots` replaces the platform defaults (tests, custom installs). */
export function listChromeProfiles(roots: { browser: Browser; dir: string }[] = userDataDirs()): ChromeProfile[] {
  const out: ChromeProfile[] = [];
  for (const root of roots) {
    let names: Record<string, { name?: string }> = {};
    try { names = JSON.parse(readFileSync(join(root.dir, "Local State"), "utf8"))?.profile?.info_cache ?? {}; } catch { /* no Local State */ }
    let dirs: string[] = [];
    try { dirs = readdirSync(root.dir).filter((d) => d === "Default" || /^Profile \d+$/.test(d)); } catch { continue; }
    for (const dir of dirs) {
      const cookiesFile = cookiesFileIn(join(root.dir, dir));
      if (cookiesFile) out.push({ browser: root.browser, dir, name: names[dir]?.name || dir, path: join(root.dir, dir), cookiesFile });
    }
  }
  return out;
}

/** The AES key for a "Safe Storage" password. */
export function deriveKey(password: string, platform: string = process.platform): Buffer {
  return pbkdf2Sync(password, "saltysalt", platform === "darwin" ? 1003 : 1, 16, "sha1");
}

type Exec = (file: string, args: string[]) => string;
const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });

/** Why cookie import cannot run on this platform, or null when it can. Windows Chrome protects cookies with DPAPI (decision 294). */
export function cookieImportBlocked(platform: string = process.platform): string | null {
  return platform === "win32" ? "Cookie import is not supported on Windows (cookies are protected with DPAPI)." : null;
}

/** The Safe Storage password. Linux: libsecret through secret-tool, else the fixed fallback. macOS: Keychain (may show a system prompt). */
export function safeStoragePassword(browser: Browser, platform: string = process.platform, exec: Exec = defaultExec): { password: string; source: "keychain" | "libsecret" | "peanuts" } {
  if (platform === "darwin") {
    const service = browser === "chromium" ? "Chromium Safe Storage" : "Chrome Safe Storage";
    const account = browser === "chromium" ? "Chromium" : "Chrome";
    const out = exec("security", ["find-generic-password", "-w", "-s", service, "-a", account]).replace(/\r?\n$/, "");
    if (!out) throw new Error("The Keychain item for Chrome Safe Storage was not found or access was denied.");
    return { password: out, source: "keychain" };
  }
  const blocked = cookieImportBlocked(platform);
  if (blocked) throw new Error(blocked);
  try {
    const out = exec("secret-tool", ["lookup", "application", browser === "chromium" ? "chromium" : "chrome"]).replace(/\r?\n$/, "");
    if (out) return { password: out, source: "libsecret" };
  } catch { /* no libsecret entry or no secret-tool */ }
  return { password: "peanuts", source: "peanuts" };
}

/** Decrypts one `encrypted_value`. Returns null when the format is unknown or the key is wrong. `hostKey` is checked for the Chrome 130+ hash prefix. */
export function decryptCookieValue(enc: Uint8Array, key: Buffer, hostKey: string, hostHashed: boolean): string | null {
  const b = Buffer.from(enc);
  if (b.length < 4) return null;
  const tag = b.subarray(0, 3).toString("latin1");
  if (tag !== "v10" && tag !== "v11") return null;
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([d.update(b.subarray(3)), d.final()]);
    if (hostHashed && plain.length >= 32) {
      const want = createHash("sha256").update(hostKey).digest();
      if (plain.subarray(0, 32).equals(want) || !/^[\x20-\x7e]*$/.test(plain.subarray(0, 32).toString("latin1"))) plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  } catch { return null; }
}

const SAME_SITE: Record<number, ImportedCookie["sameSite"]> = { [-1]: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" };
const EPOCH_DIFF_S = 11_644_473_600; // seconds between 1601-01-01 and 1970-01-01

/** Opens a private copy of the database (Chrome keeps the original locked) and runs `fn`. */
function withDb<T>(cookiesFile: string, fn: (db: DatabaseSync) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rigwell-cookies-"));
  try {
    const copy = join(dir, "Cookies");
    copyFileSync(cookiesFile, copy);
    for (const ext of ["-wal", "-shm"]) if (existsSync(cookiesFile + ext)) copyFileSync(cookiesFile + ext, copy + ext);
    const db = new DatabaseSync(copy, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const normHost = (h: string) => h.replace(/^\./, "").toLowerCase();
export const domainMatches = (hostKey: string, domain: string) => { const h = normHost(hostKey), d = normHost(domain); return h === d || h.endsWith("." + d); };

/** Domains with cookies in the profile and how many each has. Values are not read or decrypted. */
export function listCookieDomains(cookiesFile: string): DomainCount[] {
  return withDb(cookiesFile, (db) => {
    const rows = db.prepare("SELECT host_key AS host, COUNT(*) AS n FROM cookies GROUP BY host_key").all() as { host: string; n: number }[];
    const by = new Map<string, number>();
    for (const r of rows) by.set(normHost(r.host), (by.get(normHost(r.host)) ?? 0) + Number(r.n));
    return [...by].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
  });
}

/** The cookies of the chosen domains, decrypted. Cookies that cannot be decrypted are counted in `skipped`, never returned. */
export function readCookies(cookiesFile: string, domains: string[], key: Buffer): { cookies: ImportedCookie[]; skipped: number } {
  const wanted = domains.map(normHost).filter(Boolean);
  if (!wanted.length) return { cookies: [], skipped: 0 };
  return withDb(cookiesFile, (db) => {
    let version = 0;
    try { version = Number((db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined)?.value ?? 0); } catch { /* no meta table */ }
    const rows = db.prepare("SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS REAL) AS expires_utc, is_secure, is_httponly, samesite FROM cookies").all() as any[];
    const cookies: ImportedCookie[] = [];
    let skipped = 0;
    for (const r of rows) {
      if (!wanted.some((d) => domainMatches(String(r.host_key), d))) continue;
      let value: string | null = typeof r.value === "string" && r.value ? r.value : null;
      if (value === null && r.encrypted_value?.length) value = decryptCookieValue(r.encrypted_value, key, String(r.host_key), version >= 24);
      if (value === null) { if (r.encrypted_value?.length) { skipped++; continue; } value = ""; }
      const expires = Number(r.expires_utc);
      cookies.push({
        name: String(r.name), value, domain: String(r.host_key), path: String(r.path || "/"),
        secure: !!r.is_secure, httpOnly: !!r.is_httponly,
        ...(expires > 0 ? { expirationDate: Math.floor(expires / 1_000_000) - EPOCH_DIFF_S } : {}),
        sameSite: SAME_SITE[Number(r.samesite)] ?? "unspecified",
      });
    }
    return { cookies, skipped };
  });
}

/** The details Electron's `session.cookies.set` needs (it wants a URL besides the domain). */
export function toElectronCookie(c: ImportedCookie) {
  const host = c.domain.replace(/^\./, "");
  return {
    url: `${c.secure ? "https" : "http"}://${host}${c.path}`, name: c.name, value: c.value,
    ...(c.domain.startsWith(".") ? { domain: c.domain } : {}), path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
    // SameSite=None is only valid on a Secure cookie; Chromium refuses the rest, so they fall back to the browser default.
    sameSite: c.sameSite === "no_restriction" && !c.secure ? "unspecified" : c.sameSite,
  };
}

/** Whole flow for one profile and a set of domains. */
export function importFromProfile(p: ChromeProfile, domains: string[], o: { platform?: string; exec?: Exec; password?: string } = {}): { cookies: ImportedCookie[]; skipped: number; keySource: string } {
  const platform = o.platform ?? process.platform;
  const pw = o.password !== undefined ? { password: o.password, source: "given" as const } : safeStoragePassword(p.browser, platform, o.exec);
  const r = readCookies(p.cookiesFile, domains, deriveKey(pw.password, platform));
  return { ...r, keySource: pw.source };
}
