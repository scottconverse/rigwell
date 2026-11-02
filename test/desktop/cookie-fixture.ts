// A synthetic Chrome cookies database for tests (no real browser data). `makeCookieDb(file, key, hashed)` encrypts with the
// given AES key; `hashed` mimics database version 24 (SHA-256 of the host before the value).
import { createCipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SECRET_SESSION_VALUE = "secret-session-1";

export function encrypt(plain: string | Buffer, key: Buffer, tag = "v10") {
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

