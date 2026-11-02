// Chrome cookie import: decryption per OS against a synthetic cookies database and known keys. No real browser data.
import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptCookieValue, deriveKey, domainMatches, importFromProfile, listChromeProfiles, listCookieDomains, readCookies, safeStoragePassword, toElectronCookie } from "../../src/sidepane/chrome-cookies.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rigwell-cc-")); dirs.push(d); return d; };

function encrypt(plain: string | Buffer, key: Buffer, tag = "v10") {
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(tag), c.update(plain), c.final()]);
}

/** Builds a Chrome-shaped cookies database. `hashed` mimics database version 24 (host hash before the value). */
export function makeCookieDb(file: string, key: Buffer, hashed: boolean) {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT UNIQUE NOT NULL, value TEXT)");
  db.exec("CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)");
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(hashed ? "24" : "20");
  const ins = db.prepare("INSERT INTO cookies VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const wrap = (host: string, v: string) => encrypt(hashed ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(v)]) : Buffer.from(v), key);
  const expires = (1_900_000_000 + 11_644_473_600) * 1_000_000;
  ins.run(".example.com", "sid", "", wrap(".example.com", "secret-session-1"), "/", expires, 1, 1, 1);
  ins.run("app.example.com", "pref", "", wrap("app.example.com", "dark"), "/", 0, 0, 0, -1);
  ins.run("plain.example.com", "legacy", "plain-value", Buffer.alloc(0), "/", 0, 0, 0, 0);
  ins.run(".other.org", "tracker", "", wrap(".other.org", "not-selected"), "/", 0, 1, 0, 2);
  ins.run(".example.com", "broken", "", Buffer.concat([Buffer.from("v10"), Buffer.alloc(16, 7)]), "/", 0, 0, 0, 0);
  db.close();
}

test("key derivation differs per OS and matches the well-known Linux key", () => {
  expect(deriveKey("peanuts", "linux").toString("hex")).toBe("fd621fe5a2b402539dfa147ca9272778");
  expect(deriveKey("peanuts", "darwin").toString("hex")).not.toBe(deriveKey("peanuts", "linux").toString("hex"));
});

test("Linux: v10 and v11 cookies decrypt; wrong key and unknown formats give null", () => {
  const key = deriveKey("peanuts", "linux");
  expect(decryptCookieValue(encrypt("hello", key), key, "x.com", false)).toBe("hello");
  expect(decryptCookieValue(encrypt("hello", key, "v11"), key, "x.com", false)).toBe("hello");
  expect(decryptCookieValue(encrypt("hello", key), deriveKey("other", "linux"), "x.com", false)).toBeNull();
  expect(decryptCookieValue(Buffer.from("v20abcdefgh"), key, "x.com", false)).toBeNull();
});

test("reads only the selected domains, with subdomain matching, flags and expiry", () => {
  const root = tmp();
  const key = deriveKey("peanuts", "linux");
  makeCookieDb(join(root, "Cookies"), key, false);
  const r = readCookies(join(root, "Cookies"), ["example.com"], key);
  expect(r.skipped).toBe(1);
  const by = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
  expect(Object.keys(by).sort()).toEqual(["legacy", "pref", "sid"]);
  expect(by.sid.value).toBe("secret-session-1");
  expect(by.sid).toMatchObject({ domain: ".example.com", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000 });
  expect(by.pref.expirationDate).toBeUndefined();
  expect(by.legacy.value).toBe("plain-value");
  expect(r.cookies.some((c) => c.name === "tracker")).toBe(false);
  expect(readCookies(join(root, "Cookies"), [], key).cookies).toEqual([]);
});

test("database version 24 hash prefix is removed", () => {
  const root = tmp();
  const key = deriveKey("peanuts", "linux");
  makeCookieDb(join(root, "Cookies"), key, true);
  const r = readCookies(join(root, "Cookies"), ["example.com"], key);
  expect(r.cookies.find((c) => c.name === "sid")?.value).toBe("secret-session-1");
  expect(r.cookies.find((c) => c.name === "pref")?.value).toBe("dark");
});

test("macOS: key from a Keychain password (mocked security tool) with 1003 iterations", () => {
  const root = tmp();
  const pw = safeStoragePassword("chrome", "darwin", (file, args) => { expect(file).toBe("security"); expect(args).toContain("Chrome Safe Storage"); return "KeychainPass+/=\n"; });
  expect(pw).toEqual({ password: "KeychainPass+/=", source: "keychain" });
  makeCookieDb(join(root, "Cookies"), deriveKey(pw.password, "darwin"), false);
  const profile = { browser: "chrome" as const, dir: "Default", name: "Default", path: root, cookiesFile: join(root, "Cookies") };
  const r = importFromProfile(profile, ["example.com"], { platform: "darwin", exec: () => "KeychainPass+/=\n" });
  expect(r.keySource).toBe("keychain");
  expect(r.cookies.find((c) => c.name === "sid")?.value).toBe("secret-session-1");
  expect(() => safeStoragePassword("chrome", "darwin", () => "")).toThrow(/Keychain/);
});

test("Linux password: libsecret when available, peanuts otherwise", () => {
  expect(safeStoragePassword("chrome", "linux", () => "from-libsecret\n")).toEqual({ password: "from-libsecret", source: "libsecret" });
  expect(safeStoragePassword("chrome", "linux", () => { throw new Error("no secret-tool"); })).toEqual({ password: "peanuts", source: "peanuts" });
  expect(() => safeStoragePassword("chrome", "win32")).toThrow(/Windows/);
});

test("profiles are listed with their names and domains are counted without decrypting", () => {
  const root = tmp();
  const key = deriveKey("peanuts", "linux");
  mkdirSync(join(root, "Default/Network"), { recursive: true });
  mkdirSync(join(root, "Profile 2"), { recursive: true });
  mkdirSync(join(root, "Crash Reports"));
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" }, "Profile 2": { name: "Home" } } } }));
  makeCookieDb(join(root, "Default/Network/Cookies"), key, false);
  makeCookieDb(join(root, "Profile 2/Cookies"), key, false);
  const ps = listChromeProfiles([{ browser: "chrome", dir: root }, { browser: "chromium", dir: join(root, "missing") }]);
  expect(ps.map((p) => [p.dir, p.name]).sort()).toEqual([["Default", "Work"], ["Profile 2", "Home"]]);
  const domains = listCookieDomains(ps[0].cookiesFile);
  expect(domains).toContainEqual({ domain: "example.com", count: 2 });
  expect(domains).toContainEqual({ domain: "other.org", count: 1 });
  expect(JSON.stringify(domains)).not.toContain("secret-session");
});

test("domain matching and the Electron cookie shape", () => {
  expect(domainMatches(".a.example.com", "example.com")).toBe(true);
  expect(domainMatches("badexample.com", "example.com")).toBe(false);
  const c = toElectronCookie({ name: "n", value: "v", domain: ".example.com", path: "/p", secure: true, httpOnly: false, expirationDate: 5, sameSite: "lax" });
  expect(c).toMatchObject({ url: "https://example.com/p", domain: ".example.com", secure: true, expirationDate: 5 });
  expect(toElectronCookie({ name: "n", value: "v", domain: "h.test", path: "/", secure: false, httpOnly: false, sameSite: "unspecified" }).url).toBe("http://h.test/");
});
