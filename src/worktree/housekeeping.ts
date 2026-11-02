// Worktree housekeeping (spec 18.5): every 5 minutes
//   1. archive sessions whose worktree folder is gone,
//   2. remove orphaned ephemeral worktrees whose receipt is over 24 h old,
//   3. `git worktree prune` for every repo that has managed worktrees.
// The clock and the timer are injectable; `tick()` runs one pass and is what tests call.
import { existsSync } from "node:fs";
import { findSession, listSessions } from "../storage/transcript.ts";
import { readSessionSettings, updateSessionSettings } from "../storage/session-settings.ts";
import { canonicalPath, git } from "./git.ts";
import type { WorktreeManager } from "./manager.ts";

export const HOUSEKEEPING_INTERVAL_MS = 5 * 60_000;
export const ORPHAN_AGE_MS = 24 * 3600_000;

export interface SessionRecord { sessionId: string; worktreePath?: string; repoRoot?: string; archived: boolean }

/** How housekeeping sees and archives sessions. The default reads the session settings files. */
export interface HousekeepingHost {
  sessions(): SessionRecord[];
  archive(sessionId: string): void;
}

export interface HousekeepingOptions {
  manager: () => WorktreeManager;
  host?: HousekeepingHost;
  now?: () => number;
  intervalMs?: number;
  orphanAgeMs?: number;
  /** Replaceable timer, so tests need no real waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (m: string) => void;
}

export interface HousekeepingResult { archived: string[]; removed: string[]; pruned: string[] }

/** Session records from the settings files on disk (`worktree` and `archivedAt`). */
export function fileSessionHost(now: () => number = Date.now): HousekeepingHost {
  return {
    sessions() {
      const out: SessionRecord[] = [];
      for (const s of listSessions()) {
        const files = findSession(s.id);
        const st = files ? readSessionSettings(files) : null;
        const w = st?.worktree as { path?: string; repoRoot?: string } | undefined;
        out.push({ sessionId: s.id, worktreePath: w?.path, repoRoot: w?.repoRoot, archived: !!st?.archivedAt });
      }
      return out;
    },
    archive(id) {
      const files = findSession(id);
      if (files) updateSessionSettings(files, { archivedAt: new Date(now()).toISOString() });
    },
  };
}

export class Housekeeper {
  private timer: unknown;
  private busy = false;
  constructor(private o: HousekeepingOptions) {}

  private now() { return (this.o.now ?? Date.now)(); }

  async tick(): Promise<HousekeepingResult> {
    const res: HousekeepingResult = { archived: [], removed: [], pruned: [] };
    if (this.busy) return res;
    this.busy = true;
    try {
      const mgr = this.o.manager();
      const host = this.o.host ?? fileSessionHost(() => this.now());
      const sessions = host.sessions();
      const repos = new Set<string>();

      // 1. Sessions whose worktree folder is gone are archived.
      for (const s of sessions) {
        if (s.repoRoot) repos.add(canonicalPath(s.repoRoot));
        if (s.worktreePath && !s.archived && !existsSync(s.worktreePath)) {
          host.archive(s.sessionId);
          res.archived.push(s.sessionId);
        }
      }

      // 2. Orphaned ephemeral worktrees: no live session, session archived or unknown, receipt over 24 h old.
      const byId = new Map(sessions.map((s) => [s.sessionId, s]));
      const ageLimit = this.o.orphanAgeMs ?? ORPHAN_AGE_MS;
      for (const w of await mgr.list()) {
        repos.add(canonicalPath(w.repoRoot));
        if (w.lifecycle !== "ephemeral") continue;
        const rec = byId.get(w.sessionId);
        if (rec && !rec.archived) continue; // its session is still active
        const since = (await mgr.receiptTime(w.path)) ?? w.createdAt;
        if (this.now() - since < ageLimit) continue;
        if (!(await mgr.isSafeToRemove(w))) continue;
        try { await mgr.remove(w.path); res.removed.push(w.path); }
        catch (e) { this.o.log?.(`[worktree] housekeeping skipped ${w.path}: ${(e as Error).message}`); }
      }

      // 3. Forget git's records of folders that vanished.
      for (const r of repos) {
        if (!existsSync(r)) continue;
        if ((await git(r, ["worktree", "prune"])).code === 0) res.pruned.push(r);
      }
    } finally {
      this.busy = false;
    }
    return res;
  }

  start() {
    if (this.timer !== undefined) return;
    const set = this.o.setTimer ?? ((fn, ms) => { const t = setInterval(fn, ms); (t as any).unref?.(); return t; });
    this.timer = set(() => void this.tick().catch((e) => this.o.log?.(`[worktree] housekeeping failed: ${(e as Error).message}`)), this.o.intervalMs ?? HOUSEKEEPING_INTERVAL_MS);
  }

  stop() {
    if (this.timer === undefined) return;
    (this.o.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = undefined;
  }
}
