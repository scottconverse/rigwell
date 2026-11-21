import { rigwellHome } from "../storage/paths.ts";

interface LiveSession {
  readonly id: string;
  readonly isRunning: boolean;
  readonly workingState?: string;
  hasBackgroundWork(): boolean;
  queuedMessages(): unknown[];
  stopForFleet(): Promise<void>;
}
export type SessionLiveState = "working" | "waiting" | "idle";
export const liveStateFrom = (working?: string): SessionLiveState => !working || working === "idle" ? "idle" : working === "waiting_for_tool_confirmation" ? "waiting" : "working";
const stateWatchers = new Set<{ home: string; last: Map<string, SessionLiveState>; notify(sessionId: string, state: SessionLiveState): void }>();
// Include engines owned by automations, tasks and members, not just socket tabs.
// Weak references do not keep abandoned sessions alive.
const sessions = new Set<{ home: string; ref: WeakRef<LiveSession> }>();
const stopping = new Map<string, number>();
export function fleetIsStopping(home: string) { return !!stopping.get(home); }
export function registerLiveSession(session: LiveSession) {
  const row = { home: rigwellHome(), ref: new WeakRef(session) }; sessions.add(row);
  return () => { const removed = sessions.delete(row); publishLiveStates(); return removed; };
}
/** Sessions that are not idle. A session with two live engines reports the one that needs the user. */
export function liveStates(home = rigwellHome()): Map<string, SessionLiveState> {
  const states = new Map<string, SessionLiveState>();
  for (const session of liveSessions(home)) {
    const state = liveStateFrom(session.workingState);
    if (state === "waiting" || (state === "working" && !states.has(session.id))) states.set(session.id, state);
  }
  return states;
}
/** Calls `notify` once for each session whose state changes. A closed session changes to idle. */
export function watchLiveStates(notify: (sessionId: string, state: SessionLiveState) => void, home = rigwellHome()) {
  const watcher = { home, last: liveStates(home), notify };
  stateWatchers.add(watcher);
  return () => { stateWatchers.delete(watcher); };
}
export function publishLiveStates() {
  for (const watcher of stateWatchers) {
    const next = liveStates(watcher.home), last = watcher.last;
    watcher.last = next;
    for (const id of new Set([...last.keys(), ...next.keys()])) {
      const state = next.get(id) ?? "idle";
      if ((last.get(id) ?? "idle") !== state) try { watcher.notify(id, state); } catch { /* a closed client must not stop the session */ }
    }
  }
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
