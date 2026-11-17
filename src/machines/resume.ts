import { findSession } from "../storage/transcript.ts";
import { forkSession } from "../storage/fork.ts";
import { listSessionEntries, type SessionListEntry } from "../storage/session-list.ts";
import { RemoteSessionStore } from "./sessions.ts";
import { connectMachine } from "./bootstrap.ts";
import type { RpcClient } from "../sdk/client.ts";

type Connect = (name: string) => Promise<RpcClient>;
const remoteName = (name?: string) => name && !["local", "default"].includes(name) ? name : undefined;
export async function routedSessionList(cwd: string, machine?: string, connect: Connect = connectMachine) {
  const selected = remoteName(machine), store = new RemoteSessionStore();
  if (!selected) return [...listSessionEntries({ cwd }), ...(machine === undefined ? store.list().filter((r) => r.cwd === cwd && !r.isSubagent && !r.archivedAt && r.hasUserVisibleMessages) : [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const client = await connect(selected);
  try {
    const { sessions } = await client.request<{ sessions: SessionListEntry[] }>("list_sessions", { cwd });
    for (const row of sessions) store.update({ ...row, machine: selected });
    return sessions.map((row) => ({ ...row, machine: selected }));
  } finally { await client.close(); }
}

export async function forkRoutedSession(id: string, cwd: string, machine?: string, connect: Connect = connectMachine): Promise<string> {
  const local = findSession(id, cwd), store = new RemoteSessionStore(), cached = store.get(id);
  const selected = remoteName(machine) ?? (!local && machine === undefined ? cached?.machine : undefined);
  if (!selected) {
    if (!local) throw new Error(`session not found: ${id}`);
    return forkSession(local).id;
  }
  const client = await connect(selected);
  try {
    const loaded = await client.request("load_session", { sessionId: id, cwd: cached?.machine === selected ? cached.cwd : cwd });
    const { newSessionId } = await client.request<{ newSessionId: string }>("fork_session", {});
    store.update({ sessionId: newSessionId, machine: selected, cwd: loaded.cwd ?? cached?.cwd ?? cwd, title: loaded.settings?.title ?? cached?.title ?? "Forked session", updatedAt: new Date().toISOString(), pinned: false, archivedAt: null, isSubagent: false, hasUserVisibleMessages: true });
    return newSessionId;
  } finally { await client.close(); }
}
