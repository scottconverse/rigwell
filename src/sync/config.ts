import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { atomicText, type SyncTarget, unlinkedPath } from "./target.ts";

import { SETTING_KEYS } from "./options.ts";
export { SETTING_KEYS } from "./options.ts";
export type SyncKind = "session" | "automation" | "mission" | "workstream" | "settings";
export interface SyncConfig { version: 1; target: SyncTarget; kinds: SyncKind[]; settings: string[]; folderIsAuthority?: true; leaseTarget?: SyncTarget }
export const syncRoot = (home = rigwellHome()) => join(home, "sync");
export function validateConfig(input: any, home = rigwellHome()): SyncConfig {
  const target = (t: any): SyncTarget => {
    if (t?.kind === "folder" && typeof t.path === "string" && isAbsolute(t.path)) {
      const folder = unlinkedPath(t.path), local = resolve(home);
      const canonical = (p: string) => { let ancestor = p; while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor); return resolve(realpathSync(ancestor), relative(ancestor, p)); };
      const within = (parent: string, child: string) => { const r = relative(parent, child); return !r || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`)); };
      const canonicalFolder = canonical(folder), canonicalHome = canonical(local);
      if (within(canonicalFolder, canonicalHome) || within(canonicalHome, canonicalFolder)) throw new Error("Choose a sync folder outside the Rigwell home");
      return { kind: "folder", path: folder, ...(t.replicated === true ? { replicated: true } : {}) };
    }
    if (t?.kind === "git" && t.private === true && typeof t.remote === "string" && !/[\r\n\0]/.test(t.remote)) {
      const remote = t.remote;
      // No remote helpers, embedded passwords/tokens or arbitrary git transports.
      if (/^https:\/\//.test(remote)) { const u = new URL(remote); if (u.username || u.password || u.search || u.hash) throw new Error("Use the OS Git credential helper, not credentials in a remote URL"); }
      else if (!isAbsolute(remote) && !/^ssh:\/\/[a-zA-Z0-9_.@:[\]-]+\//.test(remote) && !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[a-zA-Z0-9_./-]+$/.test(remote)) throw new Error("Use a private HTTPS/SSH git remote or local bare repository");
      return { kind: "git", remote, private: true };
    }
    throw new Error("Choose a folder or confirm a private git remote");
  };
  if (!input || input.version !== 1 || !Array.isArray(input.kinds) || input.kinds.some((k: any) => !["session", "automation", "mission", "workstream", "settings"].includes(k)) || !Array.isArray(input.settings) || input.settings.some((k: any) => !SETTING_KEYS.includes(k))) throw new Error("Invalid sync selections");
  const chosen = target(input.target);
  if (chosen.kind === "folder" && chosen.replicated && !input.leaseTarget) throw new Error("Replicated folders require a separate authoritative lease target");
  if (chosen.kind === "folder" && !input.leaseTarget && input.folderIsAuthority !== true) throw new Error("Confirm one authoritative shared folder, or choose a separate lease authority for replicated folders");
  const leaseTarget = input.leaseTarget ? target(input.leaseTarget) : undefined;
  if (leaseTarget?.kind === "folder" && leaseTarget.replicated) throw new Error("A lease authority cannot be a replicated folder");
  return { version: 1, target: chosen, kinds: [...new Set(input.kinds)] as SyncKind[], settings: [...new Set(input.settings)] as string[], ...(input.folderIsAuthority === true ? { folderIsAuthority: true } : {}), ...(leaseTarget ? { leaseTarget } : {}) };
}
export function readSyncConfig(home = rigwellHome()): SyncConfig | undefined {
  const file = join(syncRoot(home), "config.json"); unlinkedPath(file);
  if (!existsSync(file)) return;
  return validateConfig(JSON.parse(readFileSync(file, "utf8")), home);
}
export function saveSyncConfig(input: unknown, home = rigwellHome()) {
  const config = validateConfig(input, home); atomicText(join(syncRoot(home), "config.json"), JSON.stringify(config)); return config;
}
