import { rigwellHome } from "../storage/paths.ts";

interface LiveSession {
  readonly id: string;
  readonly isRunning: boolean;
  hasBackgroundWork(): boolean;
  queuedMessages(): unknown[];
  stopForFleet(): Promise<void>;
}
// Include engines owned by automations, tasks and members, not just socket tabs.
// Weak references do not keep abandoned sessions alive.
const sessions = new Set<{ home: string; ref: WeakRef<LiveSession> }>();
const stopping = new Map<string, number>();
export function fleetIsStopping(home: string) { return !!stopping.get(home); }
export function registerLiveSession(session: LiveSession) {
  const row = { home: rigwellHome(), ref: new WeakRef(session) }; sessions.add(row);
  return () => sessions.delete(row);
}
export function liveSessions(home = rigwellHome()): LiveSession[] {
  const found: LiveSession[] = [];
  for (const row of sessions) {
    const session = row.ref.deref();
    if (!session) sessions.delete(row);
    else if (row.home === home) found.push(session);
  }
  return found;
}
export function runningSessionCount(home = rigwellHome()) {
  return liveSessions(home).filter((s) => s.isRunning || s.hasBackgroundWork() || s.queuedMessages().length).length;
}
export async function stopLiveSessions(home = rigwellHome()) {
  stopping.set(home, (stopping.get(home) ?? 0) + 1);
  try {
    const rows = liveSessions(home);
    await Promise.all(rows.map((s) => s.stopForFleet()));
    return { stopped: rows.length, runningSessions: runningSessionCount(home) };
  } finally {
    const count = stopping.get(home)! - 1;
    if (count) stopping.set(home, count); else stopping.delete(home);
  }
}
