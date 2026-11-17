import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { rigwellHome } from "../storage/paths.ts";
import { makePrivate } from "../platform/private.ts";
import { atomicText, unlinkedPath } from "../sync/target.ts";

export interface Project { name: string; cwd: string; modelId?: string }
export interface DelegationConfig {
  projects: Project[];
  slack?: { enabled: boolean; teamId: string; users: string[]; appTokenCredential: string; botTokenCredential: string };
  teams?: { enabled: boolean; tenantId: string; appId: string; secretCredential: string; users: string[]; publicUrl: string; port: number };
}
export interface Source { service: "slack" | "teams"; workspace: string; user: string; conversation: string; thread: string; serviceUrl?: string; botId?: string }
export interface Event { id: string; at: number; source: Source; text: string }
export interface Binding { key: string; source: Source; cwd: string; project: string; sessionId: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const credential = /^[A-Za-z0-9_.-]{1,64}$/;
function keys(o: any, allowed: string[]) { if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => !allowed.includes(k))) throw new Error("Unknown delegation configuration field"); }
function users(v: any, pattern: RegExp) { if (!Array.isArray(v) || !v.length || v.length > 100 || v.some((u) => typeof u !== "string" || !pattern.test(u))) throw new Error("Choose explicit allowed user IDs"); return [...new Set<string>(v)]; }
export function validateDelegation(input: any): DelegationConfig {
  keys(input, ["projects", "slack", "teams"]);
  if (!Array.isArray(input.projects) || input.projects.length > 40) throw new Error("Choose up to forty local projects");
  const projects: Project[] = input.projects.map((p: any) => {
    keys(p, ["name", "cwd", "modelId"]);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(p.name ?? "") || typeof p.cwd !== "string" || !isAbsolute(p.cwd) || !statSync(p.cwd).isDirectory() || (p.modelId !== undefined && (typeof p.modelId !== "string" || !p.modelId || p.modelId.length > 256))) throw new Error("Each project needs an alias and an existing absolute local folder");
    return { name: p.name, cwd: resolve(p.cwd), ...(p.modelId ? { modelId: p.modelId } : {}) };
  });
  if (new Set(projects.map((p) => p.name)).size !== projects.length) throw new Error("Project aliases must be unique");
  const result: DelegationConfig = { projects };
  if (input.slack) {
    const s = input.slack; keys(s, ["enabled", "teamId", "users", "appTokenCredential", "botTokenCredential"]);
    if (typeof s.enabled !== "boolean" || !/^T[A-Z0-9]+$/.test(s.teamId ?? "") || !credential.test(s.appTokenCredential ?? "") || !credential.test(s.botTokenCredential ?? "")) throw new Error("Slack requires a workspace ID and stored app/bot credential names");
    result.slack = { enabled: s.enabled, teamId: s.teamId, users: users(s.users, /^[UW][A-Z0-9]+$/), appTokenCredential: s.appTokenCredential, botTokenCredential: s.botTokenCredential };
  }
  if (input.teams) {
    const t = input.teams; keys(t, ["enabled", "tenantId", "appId", "secretCredential", "users", "publicUrl", "port"]);
    const url = new URL(t.publicUrl);
    if (typeof t.enabled !== "boolean" || !uuid.test(t.tenantId ?? "") || !uuid.test(t.appId ?? "") || !credential.test(t.secretCredential ?? "") || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/delegation/teams" || !Number.isInteger(t.port) || t.port < 0 || t.port > 65535) throw new Error("Teams requires registered app/tenant IDs, a stored secret name and an HTTPS tunnel URL ending /api/delegation/teams");
    result.teams = { enabled: t.enabled, tenantId: t.tenantId.toLowerCase(), appId: t.appId.toLowerCase(), secretCredential: t.secretCredential, users: users(t.users, uuid).map((s) => s.toLowerCase()), publicUrl: url.href, port: t.port };
  }
  if ((result.slack?.enabled || result.teams?.enabled) && !projects.length) throw new Error("Add a project before enabling delegation");
  return result;
}
export const sourceKey = (s: Source) => JSON.stringify([s.service, s.workspace, s.user, s.conversation, s.thread]);
export class DelegationStore {
  readonly root: string;
  constructor(home = rigwellHome()) { this.root = join(home, "delegation"); }
  private exists() { return existsSync(unlinkedPath(join(this.root, "events.db"))); }
  config(): DelegationConfig { const f = unlinkedPath(join(this.root, "config.json")); return existsSync(f) ? validateDelegation(JSON.parse(readFileSync(f, "utf8"))) : { projects: [] }; }
  save(config: DelegationConfig) { mkdirSync(unlinkedPath(this.root), { recursive: true }); makePrivate(this.root, { dir: true }); atomicText(unlinkedPath(join(this.root, "config.json")), JSON.stringify(validateDelegation(config), null, 2)); }
  db<T>(fn: (db: Database) => T): T {
    mkdirSync(unlinkedPath(this.root), { recursive: true });
    const file = unlinkedPath(join(this.root, "events.db")), fresh = !existsSync(file), db = new Database(file);
    try {
      if (fresh) makePrivate(file);
      db.exec("CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, state TEXT NOT NULL, error TEXT); CREATE TABLE IF NOT EXISTS bindings(key TEXT PRIMARY KEY, binding TEXT NOT NULL)");
      return fn(db);
    } finally { db.close(); }
  }
  enqueue(e: Event) {
    if (JSON.stringify(e).length > 256 * 1024 || e.text.length > 60_000) throw new Error("Delegation message too large");
    return this.db((db) => db.transaction(() => {
      if (db.query("SELECT id FROM events WHERE id=?").get(e.id)) return false;
      if ((db.query("SELECT count(*) AS n FROM events WHERE state='queued'").get() as any).n >= 1000) throw new Error("Delegation queue is full");
      db.query("INSERT INTO events(id,at,event,state) VALUES (?,?,?,'queued')").run(e.id, e.at, JSON.stringify(e)); return true;
    })());
  }
  queued(): Event[] { return this.exists() ? this.db((db) => (db.query("SELECT event FROM events WHERE state='queued' ORDER BY at LIMIT 10").all() as any[]).map((r) => JSON.parse(r.event))) : []; }
  state(id: string, state: string, error?: string) { this.db((db) => db.query("UPDATE events SET state=?,error=? WHERE id=?").run(state, error ?? null, id)); }
  recover() { if (this.exists()) this.db((db) => db.query("UPDATE events SET state='uncertain',error='Daemon stopped after admission; this event was not automatically replayed' WHERE state='admitted'").run()); }
  bindings(): Binding[] { return this.exists() ? this.db((db) => (db.query("SELECT binding FROM bindings").all() as any[]).map((r) => JSON.parse(r.binding))) : []; }
  bind(b: Binding) { this.db((db) => db.query("INSERT OR REPLACE INTO bindings(key,binding) VALUES (?,?)").run(b.key, JSON.stringify(b))); }
  status() { return this.exists() ? this.db((db) => ({ counts: db.query("SELECT state,count(*) AS count FROM events GROUP BY state").all(), errors: db.query("SELECT id,error FROM events WHERE error IS NOT NULL ORDER BY at DESC LIMIT 10").all() })) : { counts: [], errors: [] }; }
}
