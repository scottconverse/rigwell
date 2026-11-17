import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { makePrivate } from "../../platform/private.ts";
import { unlinkedPath } from "../../sync/target.ts";
import type { Automation } from "../store.ts";
import type { TriggerEvent } from "./events.ts";

interface Entry { id: string; state: string; event: string; runId: string | null; result: string | null; error: string | null }
/** A durable deduplication key is retained until the automation is deleted. */
export function withLedger<T>(a: Automation, action: (ledger: EventLedger) => T): T {
  const file = unlinkedPath(join(a.dir, "memory", "trigger-events.db")), existed = existsSync(file), db = new Database(file);
  try {
    if (!existed) makePrivate(file);
    // One logical transition must commit together (state/run id/admission time).
    // Autocommitting each UPDATE also forced a disk flush for every field update.
    return db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, state TEXT NOT NULL, event TEXT NOT NULL, runId TEXT, result TEXT, error TEXT, startedAt INTEGER); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      return action(new EventLedger(db));
    })();
  }
  finally { db.close(); }
}
export class EventLedger {
  constructor(private db: Database) {}
  put(event: TriggerEvent) {
    if (this.db.query("SELECT id FROM events WHERE id=?").get(event.id)) return "duplicate";
    if ((this.db.query("SELECT count(*) AS n FROM events WHERE state IN ('queued','running')").get() as { n: number }).n >= 1000) throw new Error("Trigger queue is full; event was not acknowledged");
    this.db.query("INSERT INTO events(id,state,event) VALUES (?,'queued',?)").run(event.id, JSON.stringify(event)); return "queued";
  }
  entries(state: string, limit = 20) { return this.db.query("SELECT * FROM events WHERE state=? ORDER BY rowid LIMIT ?").all(state, limit) as Entry[]; }
  get(id: string) { return this.db.query("SELECT * FROM events WHERE id=?").get(id) as Entry | undefined; }
  started(id: string, now: number) { this.db.query("UPDATE events SET startedAt=coalesce(startedAt,?) WHERE id=?").run(now, id); }
  recentCount(now: number) { return (this.db.query("SELECT count(*) AS n FROM events WHERE startedAt>?").get(now - 3600_000) as { n: number }).n; }
  set(id: string, state: string, patch: { runId?: string; result?: string; error?: string } = {}) { this.db.query("UPDATE events SET state=?,runId=coalesce(?,runId),result=coalesce(?,result),error=? WHERE id=?").run(state, patch.runId ?? null, patch.result ?? null, patch.error ?? null, id); }
  meta(key: string, value?: string) { if (value !== undefined) this.db.query("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); return (this.db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value; }
  status() { return { counts: this.db.query("SELECT state,count(*) AS count FROM events GROUP BY state").all(), recent: this.db.query("SELECT id,state,runId,error FROM events ORDER BY rowid DESC LIMIT 20").all(), lastPollAt: Number(this.meta("lastPollAt") ?? 0), error: this.meta("error") ?? "" }; }
}
