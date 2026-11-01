// Session crons (spec §16.6): small repeaters that inject a prompt into one live session.
// Files: $RIGWELL_HOME/crons/<scope>/<sessionId>/<id>.json. Delete = status "cancelled".
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rigwellHome, validateSessionId } from "../storage/paths.ts";
import { machineTimeZone, nextRun, parseSchedule } from "./schedule.ts";
import { atomicWrite } from "./store.ts";
import { systemClock, type Clock } from "./manager.ts";

export type CronStatus = "active" | "held" | "paused" | "running" | "error" | "expired" | "cancelled";

export interface CronRecord {
  id: string;
  status: CronStatus;
  source: "loop_command" | "cron_tool";
  kind: "session_prompt";
  scope: string;
  sessionId: string;
  prompt: string;
  schedule: { expression: string; recurring: boolean; nextRunAt?: number };
  stats: { fireCount: number; lastRunAt?: number; lastError?: string };
  createdAt: number;
}

/** What the daemon provides: sessions that are live in this process. */
export interface CronHost {
  isLive(sessionId: string): boolean;
  /** The previous injected prompt is still queued or running. */
  isBusy(sessionId: string): boolean;
  /** Queues the prompt as a user message with source "automation". Returns true when it was queued. */
  inject(sessionId: string, prompt: string): boolean;
}

export const MAX_LATE_MS = 30_000;
const LOOP_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const LOOP_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

/** `/loop` interval ("30m", "2h") to an exact cron expression anchored to the creation minute. */
export function loopIntervalToCron(text: string, at: Date): string {
  const m = /^(\d+)\s*(m|h)$/i.exec(text.trim());
  if (!m) throw new Error(`Interval must look like 30m or 2h, got "${text}"`);
  const n = Number(m[1]);
  const min = at.getMinutes(), hour = at.getHours();
  if (m[2].toLowerCase() === "m") {
    if (!LOOP_MINUTES.includes(n)) throw new Error(`Minute steps must be one of ${LOOP_MINUTES.join(", ")}`);
    return n === 1 ? "* * * * *" : `${min % n}-59/${n} * * * *`;
  }
  if (!LOOP_HOURS.includes(n)) throw new Error(`Hour steps must be one of ${LOOP_HOURS.join(", ")}`);
  return n === 24 ? `${min} ${hour} * * *` : `${min} ${hour % n}-23/${n} * * *`;
}

export class CronStore {
  constructor(private clock: Clock = systemClock) {}
  private root() { return join(rigwellHome(), "crons"); }
  private file(c: Pick<CronRecord, "scope" | "sessionId" | "id">) { return join(this.root(), c.scope, c.sessionId, `${c.id}.json`); }

  list(filter: { sessionId?: string; scope?: string; includeInactive?: boolean } = {}): CronRecord[] {
    const out: CronRecord[] = [];
    if (!existsSync(this.root())) return out;
    for (const scope of readdirSync(this.root())) {
      if (filter.scope && scope !== filter.scope) continue;
      const sdir = join(this.root(), scope);
      for (const sid of readdirSync(sdir)) {
        if (filter.sessionId && sid !== filter.sessionId) continue;
        for (const f of readdirSync(join(sdir, sid))) {
          if (!f.endsWith(".json")) continue;
          try {
            const c = JSON.parse(readFileSync(join(sdir, sid, f), "utf8")) as CronRecord;
            if (filter.includeInactive || (c.status !== "cancelled" && c.status !== "expired")) out.push(c);
          } catch { /* skip unreadable file */ }
        }
      }
    }
    return out;
  }

  get(id: string): CronRecord {
    const c = this.list({ includeInactive: true }).find((x) => x.id === id);
    if (!c) throw new Error(`Cron not found: ${id}`);
    return c;
  }

  private write(c: CronRecord) {
    mkdirSync(join(this.root(), c.scope, c.sessionId), { recursive: true });
    atomicWrite(this.file(c), JSON.stringify(c, null, 2));
  }

  create(p: { sessionId: string; prompt: string; expression: string; recurring?: boolean; source?: CronRecord["source"]; scope?: string }): CronRecord {
    validateSessionId(p.sessionId);
    if (!p.prompt.trim()) throw new Error("prompt is required");
    const sched = parseSchedule(p.expression);
    const now = this.clock.now();
    const c: CronRecord = {
      id: randomBytes(4).toString("hex"), status: "active", source: p.source ?? "cron_tool", kind: "session_prompt",
      scope: (p.scope ?? "default").replace(/[\\/]/g, "_"), sessionId: p.sessionId, prompt: p.prompt, createdAt: now,
      schedule: { expression: p.expression, recurring: p.recurring ?? true, nextRunAt: nextRun(sched, now, machineTimeZone(), now) },
      stats: { fireCount: 0 },
    };
    this.write(c);
    return c;
  }

  update(id: string, patch: { status?: CronStatus; prompt?: string; expression?: string }): CronRecord {
    const c = this.get(id);
    if (patch.prompt !== undefined) c.prompt = patch.prompt;
    if (patch.expression !== undefined) {
      const s = parseSchedule(patch.expression);
      c.schedule.expression = patch.expression;
      c.schedule.nextRunAt = nextRun(s, this.clock.now(), machineTimeZone(), c.createdAt);
    }
    if (patch.status !== undefined) {
      c.status = patch.status;
      if (patch.status === "active") c.schedule.nextRunAt = nextRun(parseSchedule(c.schedule.expression), this.clock.now(), machineTimeZone(), c.createdAt);
    }
    this.write(c);
    return c;
  }

  delete(id: string): CronRecord { return this.update(id, { status: "cancelled" }); }

  save(c: CronRecord) { this.write(c); }
}

export class CronRunner {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: CronStore, private host: CronHost, private clock: Clock = systemClock, private onChange?: (c: CronRecord) => void) {}

  start(tickMs = 15_000) { this.timer = setInterval(() => this.tick(), tickMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Fires what is due. A fire more than 30 s late is skipped (one-shots expire); there is no catch-up. */
  tick() {
    const now = this.clock.now();
    for (const c of this.store.list()) {
      if (c.status !== "active" && c.status !== "held") continue;
      const due = c.schedule.nextRunAt;
      if (due === undefined || now < due) continue;
      const advance = () => {
        c.schedule.nextRunAt = nextRun(parseSchedule(c.schedule.expression), now, machineTimeZone(), c.createdAt);
      };
      const finish = () => { this.store.save(c); this.onChange?.(c); };
      if (now - due > MAX_LATE_MS) {
        if (c.schedule.recurring) advance(); else c.status = "expired";
        finish();
        continue;
      }
      if (!this.host.isLive(c.sessionId)) { c.status = "held"; if (c.schedule.recurring) advance(); else c.status = "expired"; finish(); continue; }
      if (this.host.isBusy(c.sessionId)) { if (c.schedule.recurring) advance(); finish(); continue; } // never queue two
      let queued = false;
      try { queued = this.host.inject(c.sessionId, c.prompt); } catch (e) { c.stats.lastError = (e as Error).message; }
      if (queued) { c.stats.fireCount++; c.stats.lastRunAt = now; c.status = "active"; }
      if (c.schedule.recurring) advance(); else c.status = "expired";
      finish();
    }
  }
}
