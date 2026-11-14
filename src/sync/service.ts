import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseHeartbeat, serializeHeartbeat, type Frontmatter } from "../automations/store.ts";
import { SessionLease } from "./lease.ts";
import { hostId, projectSlug, rigwellHome } from "../storage/paths.ts";
import { readSyncConfig, saveSyncConfig, SETTING_KEYS, syncRoot, validateConfig } from "./config.ts";
import { collectSnapshot, hashFiles, itemKey } from "./snapshot.ts";
import { atomicText, SyncRepository, unlinkedPath, type SyncItem } from "./target.ts";

interface LocalState { baseline: Record<string, string>; items: Record<string, SyncItem>; conflicts: SyncItem[]; lastSync?: number }
const readLocal = (home: string): LocalState => {
  const file = join(syncRoot(home), "replicas.json"); unlinkedPath(file);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { baseline: {}, items: {}, conflicts: [] };
};
export function syncStatus(home = rigwellHome()) {
  const config = readSyncConfig(home), state = readLocal(home);
  return { config, lastSync: state.lastSync, items: Object.values(state.items).map(({ files: _, ...item }) => item), conflicts: state.conflicts.map(({ files: _, ...item }) => item) };
}
export async function configureSync(input: unknown, home = rigwellHome()) {
  const old = readSyncConfig(home), next = input === null ? undefined : validateConfig(input, home);
  if (old && JSON.stringify(old) !== JSON.stringify(next)) {
    await new SyncRepository(old.leaseTarget ?? old.target, join(syncRoot(home), "lease-git")).transaction((d) => {
      if (Object.values(d.leases).some((lease) => lease.expiresAt > Date.now())) throw new Error("Close synced session engines before changing or disabling sync");
    });
  }
  if (next) saveSyncConfig(next, home); else rmSync(join(syncRoot(home), "config.json"), { force: true });
  if (next && old && JSON.stringify(old.target) !== JSON.stringify(next.target)) atomicText(join(syncRoot(home), "replicas.json"), JSON.stringify({ baseline: {}, items: {}, conflicts: [] }));
  return syncStatus(home);
}
export async function syncNow(options: { home?: string; owner?: string; secrets?: string[] } = {}) {
  const home = options.home ?? rigwellHome(), config = readSyncConfig(home);
  if (!config) throw new Error("Sync is off; choose a sync target first");
  const state = readLocal(home), local = collectSnapshot(config, { ...options, home });
  const repo = new SyncRepository(config.target, join(syncRoot(home), "git"));
  const next = await repo.transaction((remote) => {
    for (const item of local) {
      const old = remote.items[item.key], base = state.baseline[item.key];
      if (old?.hash === item.hash) continue;
      if (old && base === item.hash) continue; // Only the remote changed; retain the replica until explicit restore.
      if (!old || (old.hash === base && old.owner === item.owner)) remote.items[item.key] = { ...item, ...(old ? { parent: old.revision ?? old.hash } : {}) };
      else if (!remote.conflicts.some((c) => c.key === item.key && c.hash === item.hash)) remote.conflicts.push(item);
    }
    return structuredClone(remote);
  });
  const baseline = { ...state.baseline };
  for (const item of local) baseline[item.key] = item.hash;
  const updated: LocalState = { baseline, items: next.items, conflicts: next.conflicts, lastSync: Date.now() };
  atomicText(join(syncRoot(home), "replicas.json"), JSON.stringify(updated));
  // A portable logical index travels with transcripts; each machine retains/rebuilds its own SQLite cache.
  atomicText(join(syncRoot(home), "session-index.json"), JSON.stringify(Object.values(next.items).filter((i) => i.key.startsWith("session/")).map(({ key, owner, hash, updatedAt }) => ({ sessionId: key.slice(8), owner, hash, updatedAt }))));
  return syncStatus(home);
}
export function syncedItem(key: string, hash?: string, home = rigwellHome()) {
  const [kind, id, ...tail] = key.split("/"); if (tail.length || !kind || !id || itemKey(kind, id) !== key) throw new Error("Invalid sync item key");
  const state = readLocal(home), item = [state.items[key], ...state.conflicts.filter((i) => i.key === key)].find((i) => i && (!hash || i.hash === hash));
  if (!item || hashFiles(item.files) !== item.hash) throw new Error("Synced item is missing or corrupt");
  return item;
}
/** Restoring is separate from sync: no imported job is allowed to start automatically. */
export async function restoreSyncedItem(key: string, options: { home?: string; hash?: string; cwd?: string; owner?: string } = {}) {
  const home = options.home ?? rigwellHome(), config = readSyncConfig(home); if (!config) throw new Error("Sync is off");
  const item = syncedItem(key, options.hash, home), [kind, id] = key.split("/") as [string, string];
  const owner = options.owner ?? hostId();
  if (kind === "session" && !options.cwd) throw new Error("Choose this machine's working directory before restoring a session");
  const files: Record<string, string> = {};
  const allowed: Record<string, string[]> = {
    session: [`${id}.jsonl`, `${id}.settings.json`], automation: ["HEARTBEAT.md", "memory.md", "state.json"],
    mission: ["state.json", "features.json", "mission.md", "validation-contract.md", "validation-state.json", "progress_log.jsonl", "handoffs.jsonl"],
    workstream: ["workstream.json", "roster.json", "listeners.json", "messages.jsonl", "events.jsonl"], settings: ["settings.json"],
  };
  for (const [name, content] of Object.entries(item.files)) {
    if (!allowed[kind]?.includes(name)) throw new Error("Unexpected synced file");
    files[name] = content;
  }
  let directory: string;
  if (kind === "session") {
    directory = join(home, "sessions", projectSlug(options.cwd!));
    const lines = files[`${id}.jsonl`]?.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (!lines?.length || lines[0].type !== "session_start" || lines[0].id !== id) throw new Error("Invalid synced transcript");
    lines[0] = { ...lines[0], cwd: options.cwd, hostId: owner, owner };
    files[`${id}.jsonl`] = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    // Do not restore auto-approved autonomy from a different machine.
    const settings = JSON.parse(files[`${id}.settings.json`] ?? "{}"); settings.autonomyLevel = "off";
    files[`${id}.settings.json`] = JSON.stringify(settings);
  } else if (kind === "settings") {
    directory = home; const file = join(home, "settings.json"); unlinkedPath(file);
    const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const selected = JSON.parse(files["settings.json"] ?? "{}");
    for (const setting of config.settings) if (SETTING_KEYS.includes(setting as any) && ["string", "boolean", "number"].includes(typeof selected[setting])) current[setting] = selected[setting];
    files["settings.json"] = JSON.stringify(current, null, 2) + "\n";
  } else {
    directory = join(home, `${kind}s`, id);
    if (kind === "automation") {
      const { fm, body } = parseHeartbeat(files["HEARTBEAT.md"] ?? "");
      files["HEARTBEAT.md"] = serializeHeartbeat({ ...fm, paused: true } as Frontmatter, body);
      if (files["state.json"]) { const state = JSON.parse(files["state.json"]); delete state.retry; files["state.json"] = JSON.stringify({ ...state, pausedAt: Date.now() }); }
    }
    if (kind === "mission") { const state = JSON.parse(files["state.json"] ?? "null"); if (!state) throw new Error("Missing mission state"); files["state.json"] = JSON.stringify({ ...state, state: "paused", pauseReason: "Restored from sync; review workspace and resume explicitly" }); }
    if (kind === "workstream") {
      const ws = JSON.parse(files["workstream.json"] ?? "null"); if (!ws) throw new Error("Missing Workstream metadata");
      files["workstream.json"] = JSON.stringify({ ...ws, state: "paused" });
      files["listeners.json"] = "[]";
      files["roster.json"] = JSON.stringify(JSON.parse(files["roster.json"] ?? "[]").map((agent: any) => ({ ...agent, status: "interrupted" })));
    }
  }
  // A live lease prevents changing the same session's on-disk transcript during execution.
  const lease = new SessionLease(key, owner, config, home, () => {});
  await lease.acquire();
  try {
    const backup = join(syncRoot(home), "backups", crypto.randomUUID());
    // Preserve every existing file before replacing it, including local edits not uploaded yet.
    for (const name of Object.keys(files)) {
      const file = join(directory, name); unlinkedPath(file);
      if (existsSync(file)) atomicText(join(backup, name), readFileSync(file, "utf8"));
    }
    for (const [name, content] of Object.entries(files)) atomicText(join(directory, name), content);
    const restored = await new SyncRepository(config.target, join(syncRoot(home), "git")).transaction((d) => {
      const current = d.items[key];
      if (current && current.hash !== item.hash && !d.conflicts.some((c) => c.key === current.key && c.hash === current.hash)) d.conflicts.push(current);
      const published = kind === "settings" ? item.files : files;
      const hash = hashFiles(published);
      d.items[key] = { key, owner, hash, revision: crypto.randomUUID(), parent: item.revision ?? item.hash, updatedAt: Date.now(), files: published };
      return d.items[key]!;
    });
    const state = readLocal(home); state.baseline[key] = restored.hash; state.items[key] = restored;
    atomicText(join(syncRoot(home), "replicas.json"), JSON.stringify(state));
    return { restored: true, key, owner, ...(existsSync(backup) ? { backup } : {}), paused: kind !== "session" && kind !== "settings", ...(kind === "session" ? { sessionId: id } : {}) };
  } finally { await lease.release(); }
}
