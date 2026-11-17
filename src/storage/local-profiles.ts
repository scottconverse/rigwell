// App-data profiles, separate from model profiles and repository worktree setup profiles.
// Node-only imports keep the same implementation usable by Electron and Bun.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;
export interface LocalProfile { schemaVersion: 1; id: string; name: string; role: string }
export function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error("Profile ID must be 1 to 48 lowercase letters, digits or hyphens, starting with a letter");
  return value;
}
export function profileRoot(env: Env = process.env) { return resolve(env.RIGWELL_PROFILE_ROOT || env.RIGWELL_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".rigwell")); }
export function activeProfile(env: Env = process.env) { return profileId(env.RIGWELL_PROFILE || "default"); }
export function localProfileHome(root: string, id: string) { profileId(id); return id === "default" ? resolve(root) : join(resolve(root), "profiles", id); }
function directory(path: string, create = false) {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Profile directory must not be a link or a file");
}
function checkHome(root: string, id: string) {
  if (id !== "default") { directory(join(root, "profiles")); directory(localProfileHome(root, id)); }
}
function metadata(id: string, value: unknown): LocalProfile {
  const v = value as LocalProfile;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((k) => !["schemaVersion", "id", "name", "role"].includes(k)) || v.schemaVersion !== 1 || v.id !== id || typeof v.name !== "string" || !v.name.trim() || v.name.length > 100 || typeof v.role !== "string" || v.role.length > 100) throw new Error("Invalid local profile metadata");
  return { schemaVersion: 1, id, name: v.name.trim(), role: v.role.trim() };
}
export function readLocalProfile(root: string, id: string): LocalProfile {
  profileId(id); checkHome(root, id); const file = join(localProfileHome(root, id), "profile.json");
  if (id === "default" && !existsSync(file)) return { schemaVersion: 1, id, name: "Default", role: "" };
  const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) throw new Error("Profile metadata must be a regular unlinked file of at most 64 KiB");
  return metadata(id, JSON.parse(readFileSync(file, "utf8")));
}
export function listLocalProfiles(root = profileRoot()) {
  const rows = [readLocalProfile(root, "default")], dir = join(root, "profiles");
  if (!existsSync(dir)) return rows;
  directory(dir); const entries = readdirSync(dir, { withFileTypes: true }); if (entries.length > 200) throw new Error("Too many local profile entries");
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !e.isSymbolicLink() && /^[a-z][a-z0-9-]{0,47}$/.test(e.name) && e.name !== "default") rows.push(readLocalProfile(root, e.name));
  return rows;
}
export function createLocalProfile(root: string, id: string, name = id, role = "") {
  profileId(id); if (id === "default") throw new Error("The default profile already exists"); const row = metadata(id, { schemaVersion: 1, id, name, role });
  mkdirSync(root, { recursive: true, mode: 0o700 }); directory(join(root, "profiles"), true); const home = localProfileHome(root, id); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "profile.json"), JSON.stringify(row) + "\n", { mode: 0o600, flag: "wx" }); return row;
}
export function updateLocalProfile(root: string, id: string, name: string, role: string) {
  readLocalProfile(root, id); const row = metadata(id, { schemaVersion: 1, id, name, role }); const home = localProfileHome(root, id); mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = join(home, `profile.${process.pid}.${crypto.randomUUID()}.tmp`); writeFileSync(temp, JSON.stringify(row) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, join(home, "profile.json")); return row;
}
export function activateLocalProfile(id: string, env: Env = process.env) {
  const root = profileRoot(env); readLocalProfile(root, profileId(id)); env.RIGWELL_PROFILE_ROOT = root; env.RIGWELL_PROFILE = id; env.RIGWELL_HOME = localProfileHome(root, id); return env.RIGWELL_HOME;
}
/** Reserved global option, accepted before --. All remaining arguments retain their original order. */
export function profileOption(argv: string[]) {
  const args: string[] = []; let id: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") { args.push(...argv.slice(i)); break; }
    if (argv[i] === "--profile") { if (id !== undefined) throw new Error("Specify --profile only once"); id = profileId(argv[++i]); }
    else args.push(argv[i]!);
  }
  return { args, id };
}
export function applyProfileOption(argv: string[], env: Env = process.env) { const parsed = profileOption(argv); if (parsed.id !== undefined) activateLocalProfile(parsed.id, env); return parsed.args; }
export function profileSwitchArgs(argv: string[], id: string) {
  const args = profileOption(argv).args, at = args.indexOf("--");
  // Electron's development app path must remain before custom option values.
  args.splice(at < 0 ? args.length : at, 0, "--profile", profileId(id)); return args;
}
