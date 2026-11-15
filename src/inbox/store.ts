import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { makePrivate } from "../platform/private.ts";
import { atomicText, unlinkedPath } from "../sync/target.ts";

import { CATEGORIES, defaultEmail, type Category, type EmailConfig, type Frequency } from "./types.ts";
export { CATEGORIES, defaultEmail, type Category, type EmailConfig, type Frequency } from "./types.ts";
function keys(o: any, allowed: string[]) { if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => !allowed.includes(k))) throw new Error("Unknown email configuration field"); }
export function validateEmail(input: any): EmailConfig {
  keys(input, Object.keys(defaultEmail())); keys(input.categories, [...CATEGORIES]);
  if (typeof input.enabled !== "boolean" || typeof input.secure !== "boolean" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !Number.isInteger(input.digestHour) || input.digestHour < 0 || input.digestHour > 23 || CATEGORIES.some((c) => !["off", "immediate", "digest"].includes(input.categories[c]))) throw new Error("Choose valid SMTP settings and a frequency for each category");
  for (const k of ["host", "user", "passwordCredential", "from", "to"]) if (typeof input[k] !== "string" || input[k].length > 254 || /[\x00-\x20\x7f]/.test(input[k])) throw new Error("SMTP fields must be single values without whitespace or control characters");
  if (input.host && !/^[a-zA-Z0-9.-]+$/.test(input.host)) throw new Error("Enter an SMTP hostname, not a URL");
  if (input.passwordCredential && !/^[A-Za-z0-9_.-]{1,64}$/.test(input.passwordCredential)) throw new Error("Enter a stored password name");
  const email = /^[^<>@,;:\s]+@[^<>@,;:\s]+\.[^<>@,;:\s]+$/;
  if ((input.from && !email.test(input.from)) || (input.to && !email.test(input.to)) || (input.enabled && (!input.host || !input.user || !input.passwordCredential || !email.test(input.from) || !email.test(input.to)))) throw new Error("Enabled email needs a server, username, stored password name, sender and one recipient address");
  return { ...input, categories: { ...input.categories } };
}
export interface InboxItem { id: string; category: Category; at: number; title: string; detail: string; route: string; sessionId?: string; requestId?: string; read: boolean; resolved: boolean }
export interface StoredItem extends InboxItem { mode: Frequency; due: number; delivery: string }
export class InboxStore {
  readonly root: string;
  constructor(home = rigwellHome()) { this.root = join(home, "inbox"); }
  private exists() { return existsSync(unlinkedPath(join(this.root, "inbox.db"))); }
  db<T>(fn: (db: Database) => T): T {
    mkdirSync(unlinkedPath(this.root), { recursive: true, mode: 0o700 });
    const file = unlinkedPath(join(this.root, "inbox.db")), fresh = !existsSync(file), db = new Database(file);
    try {
      if (fresh) { makePrivate(this.root, { dir: true }); makePrivate(file); }
      db.exec("CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, category TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, route TEXT NOT NULL, sessionId TEXT, requestId TEXT, read INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL, due INTEGER NOT NULL, delivery TEXT NOT NULL); CREATE INDEX IF NOT EXISTS items_at ON items(at)");
      return fn(db);
    } finally { db.close(); }
  }
  config(): EmailConfig { const f = unlinkedPath(join(this.root, "email.json")); return existsSync(f) ? validateEmail(JSON.parse(readFileSync(f, "utf8"))) : defaultEmail(); }
  save(config: EmailConfig) { mkdirSync(unlinkedPath(this.root), { recursive: true, mode: 0o700 }); makePrivate(this.root, { dir: true }); const file = join(this.root, "email.json"); atomicText(file, JSON.stringify(validateEmail(config), null, 2)); makePrivate(file); }
  add(item: InboxItem, mode: Frequency, due: number) {
    return this.db((db) => db.transaction(() => {
      const changed = db.query("INSERT OR IGNORE INTO items(id,category,at,title,detail,route,sessionId,requestId,read,resolved,mode,due,delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(item.id, item.category, item.at, item.title, item.detail, item.route, item.sessionId ?? null, item.requestId ?? null, Number(item.read), Number(item.resolved), mode, due, mode === "off" ? "off" : "queued").changes > 0;
      db.exec("DELETE FROM items WHERE id IN (SELECT id FROM items WHERE resolved=1 AND delivery!='sending' ORDER BY at DESC LIMIT -1 OFFSET 5000)"); return changed;
    })());
  }
  list(p: { category?: unknown; unread?: unknown; before?: unknown; limit?: unknown } = {}) {
    if (p.category !== undefined && !CATEGORIES.includes(p.category as Category)) throw new Error("Unknown Inbox category");
    const limit = typeof p.limit === "number" && Number.isInteger(p.limit) ? Math.min(200, Math.max(1, p.limit)) : 100;
    const cursor = p.before as { at: number; id: string } | undefined;
    if (cursor !== undefined && (!cursor || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string" || cursor.id.length > 512)) throw new Error("Invalid Inbox cursor");
    if (!this.exists()) return { items: [] as InboxItem[], unread: 0 };
    return this.db((db) => {
      const rows = db.query("SELECT id,category,at,title,detail,route,sessionId,requestId,read,resolved FROM items WHERE (? IS NULL OR category=?) AND (?=0 OR read=0) AND (at<? OR (at=? AND id>?)) ORDER BY at DESC,id LIMIT ?").all(p.category as string ?? null, p.category as string ?? null, p.unread === true ? 1 : 0, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.at ?? Number.MAX_SAFE_INTEGER, cursor?.id ?? "", limit) as any[];
      return { items: rows.map((r) => ({ ...r, read: !!r.read, resolved: !!r.resolved })), unread: (db.query("SELECT count(*) AS n FROM items WHERE read=0").get() as any).n as number };
    });
  }
  mark(ids: string[], read: boolean) { if (!this.exists()) return; this.db((db) => db.transaction(() => { const q = db.query("UPDATE items SET read=? WHERE id=?"); for (const id of ids) q.run(Number(read), id); })()); }
  resolve(sessionId: string, requestId?: string) { if (this.exists()) this.db((db) => db.query("UPDATE items SET resolved=1 WHERE sessionId=? AND (? IS NULL OR requestId=?) AND category IN ('permission','question')").run(sessionId, requestId ?? null, requestId ?? null)); }
  recover() { if (this.exists()) this.db((db) => { db.exec("UPDATE items SET delivery='uncertain' WHERE delivery='sending'; UPDATE items SET resolved=1 WHERE category IN ('permission','question')"); }); }
  cancelQueued() { if (this.exists()) this.db((db) => db.exec("UPDATE items SET delivery='cancelled' WHERE delivery='queued'")); }
  due(now: number): StoredItem[] { return this.exists() ? this.db((db) => db.query("SELECT * FROM items WHERE delivery='queued' AND due<=? ORDER BY at,id LIMIT 100").all(now) as StoredItem[]) : []; }
  delivery(ids: string[], state: string) { this.db((db) => db.transaction(() => { const q = db.query("UPDATE items SET delivery=? WHERE id=?"); for (const id of ids) q.run(state, id); })()); }
  deliveries() { return this.exists() ? this.db((db) => db.query("SELECT delivery,count(*) AS count FROM items GROUP BY delivery").all()) : []; }
}
