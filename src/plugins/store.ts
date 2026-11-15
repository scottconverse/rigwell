import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { makePrivate } from "../platform/private.ts";

export const COMPONENTS = ["skills", "agents", "hooks", "mcp", "commands", "automationTemplates"] as const;
export type Component = typeof COMPONENTS[number];
export interface PluginManifest { name: string; version: string; description: string; skills?: string; agents?: string; hooks?: string; mcp?: string; commands?: string; automationTemplates?: string }
export interface PluginSource { source: string; commit?: string; subdir?: string }
export interface PluginRecord { name: string; manifest: PluginManifest; source: PluginSource; digest: string; enabled: boolean; installedAt: number }
export interface Marketplace { name: string; source: PluginSource; plugins: { name: string; source: string; commit: string; subdir?: string; description?: string }[] }
export interface PluginState { plugins: PluginRecord[]; indexes: Marketplace[] }
export const pluginRoot = () => join(rigwellHome(), "plugins");
export function ensurePluginRoot() { const root = pluginRoot(); unlinked(root); const fresh = !existsSync(root); mkdirSync(root, { recursive: true, mode: 0o700 }); if (fresh) makePrivate(root, { dir: true }); return root; }
export const validName = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
export const validCommit = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
export function unlinked(path: string) {
  let current = resolve(path);
  for (;;) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Plugin paths cannot contain links"); const parent = resolve(current, ".."); if (parent === current) break; current = parent; }
}
export function inside(root: string, path: string) {
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Plugin component must be inside its snapshot");
  unlinked(target);
  return target;
}
export function jsonFile(file: string): any {
  unlinked(file); if (lstatSync(file).size > 1024 * 1024) throw new Error("Plugin JSON exceeds 1 MiB");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function manifestAt(root: string): PluginManifest {
  const m = jsonFile(join(root, "rigwell-plugin.json"));
  if (!m || typeof m !== "object" || Array.isArray(m) || !validName(m.name) || typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(m.version) || typeof m.description !== "string" || m.description.length > 2000) throw new Error("Invalid plugin name, version or description");
  if (Object.keys(m).some((k) => !["name", "version", "description", ...COMPONENTS].includes(k))) throw new Error("Unknown plugin manifest field");
  let count = 0;
  for (const k of COMPONENTS) if (m[k] !== undefined) {
    if (typeof m[k] !== "string" || !m[k] || isAbsolute(m[k]) || /[\0\r\n]/.test(m[k])) throw new Error(`Invalid plugin ${k} path`);
    const st = lstatSync(inside(root, m[k]));
    if (["skills", "agents", "commands"].includes(k) ? !st.isDirectory() : !st.isFile()) throw new Error(`Invalid plugin ${k} component`);
    count++;
  }
  if (!count) throw new Error("A plugin must contribute at least one component");
  return m;
}
/** No links, executable lifecycle scripts, or source checkout metadata are followed during snapshotting. */
export function snapshotFiles(root: string) {
  unlinked(root); const base = realpathSync(root), files: { path: string; data: Buffer; mode: number }[] = []; let bytes = 0, entries = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      if (++entries > 4000) throw new Error("Plugin exceeds 4000 entries");
      const path = join(dir, name), st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error("Plugin snapshots cannot contain links");
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) { bytes += st.size; if (st.size > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("Plugin exceeds snapshot size limits"); files.push({ path: relative(base, path).replaceAll("\\", "/"), data: readFileSync(path), mode: st.mode & 0o777 }); }
      else throw new Error("Plugin snapshots accept regular files only");
    }
  };
  walk(base); return files;
}
export function snapshotDigest(root: string) {
  const hash = createHash("sha256");
  for (const f of snapshotFiles(root)) hash.update(f.path).update("\0").update(String(f.mode & 0o111)).update("\0").update(String(f.data.length)).update("\0").update(f.data);
  return hash.digest("hex");
}
export function readPluginState(): PluginState {
  const file = join(pluginRoot(), "state.json");
  if (!existsSync(file)) return { plugins: [], indexes: [] };
  const state = jsonFile(file);
  if (!Array.isArray(state.plugins) || !Array.isArray(state.indexes) || state.plugins.length > 100 || state.indexes.length > 30) throw new Error("Invalid plugin state");
  for (const p of state.plugins) if (!validName(p.name) || !/^[a-f0-9]{64}$/.test(p.digest) || typeof p.enabled !== "boolean") throw new Error("Invalid plugin record");
  return state;
}
export function savePluginState(state: PluginState) {
  ensurePluginRoot();
  const file = join(pluginRoot(), "state.json"), tmp = file + ".tmp"; unlinked(file); unlinked(tmp);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, file);
}
export function installedPath(p: PluginRecord) { return inside(pluginRoot(), `installed/${p.name}/${p.digest}`); }
export function activePlugins(): { record: PluginRecord; root: string; manifest: PluginManifest }[] {
  try {
    return readPluginState().plugins.filter((p) => p.enabled).flatMap((record) => {
      try { const root = installedPath(record); if (snapshotDigest(root) !== record.digest) return []; const manifest = manifestAt(root); return manifest.name === record.name ? [{ record, root, manifest }] : []; } catch { return []; }
    });
  } catch { return []; } // invalid or changed assets never acquire executable authority
}
export function pluginComponents(kind: Component) {
  return activePlugins().flatMap((p) => p.manifest[kind] ? [{ ...p, path: inside(p.root, p.manifest[kind]!) }] : []);
}
