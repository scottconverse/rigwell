import { lstatSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Owned worktree only, with native notifications plus reconciliation for dropped events. */
export function watchRemoteFiles(rootPath: string, pattern: string, fire: (event: { path: string; change: string }) => void, log?: (m: string) => void) {
  const root = realpathSync(rootPath);
  if (isAbsolute(pattern)) pattern = relative(root, pattern).replaceAll("\\", "/");
  pattern = pattern.replaceAll("\\", "/");
  if (!pattern || pattern.split("/").includes("..") || isAbsolute(pattern)) throw new Error("Remote file glob must stay inside the member worktree");
  const glob = new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`);
  const inside = (path: string) => { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); };
  const stamp = (path: string) => {
    try { const st = lstatSync(path, { bigint: true }); return !st.isSymbolicLink() && inside(realpathSync(path)) ? `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : undefined; } catch { return undefined; }
  };
  let previous = new Map<string, string>();
  for (const name of glob.scanSync({ cwd: root, dot: true, followSymlinks: false, onlyFiles: false })) { const path = resolve(root, name), value = stamp(path); if (value !== undefined) previous.set(path, value); }
  let stopped = false, scanning = false, revision = 0, watcher: FSWatcher | undefined;
  const reconcile = async () => {
    if (stopped || scanning) return;
    scanning = true;
    const at = revision;
    try {
      const current = new Map<string, string>();
      for await (const name of glob.scan({ cwd: root, dot: true, followSymlinks: false, onlyFiles: false })) {
        if (stopped) return;
        const path = resolve(root, name);
        try { const st = await lstat(path, { bigint: true }); if (!st.isSymbolicLink() && inside(await realpath(path))) current.set(path, `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`); } catch {}
      }
      if (stopped || at !== revision) return;
      const before = previous; previous = current;
      for (const path of new Set([...before.keys(), ...current.keys()])) if (!stopped && before.get(path) !== current.get(path)) fire({ path, change: !before.has(path) || !current.has(path) ? "rename" : "change" });
    } catch (e) { log?.(`Remote file reconciliation: ${(e as Error).message}`); }
    finally { scanning = false; }
  };
  const poll = setInterval(reconcile, 1000); poll.unref();
  try {
    watcher = watch(root, { recursive: true }, (change, filename) => {
      if (stopped) return;
      if (!filename) { void reconcile(); return; }
      const name = String(filename).replaceAll("\\", "/");
      if (!glob.match(name)) return;
      const path = resolve(root, name);
      if (!inside(path)) return;
      const value = stamp(path);
      if (value === undefined && !previous.has(path)) return;
      revision++;
      if (value === undefined) previous.delete(path); else previous.set(path, value);
      fire({ path, change });
    });
    watcher.on("error", (e) => log?.(`Remote file watcher: ${e.message}`)); watcher.unref();
  } catch (e) { log?.(`Remote file watcher uses reconciliation: ${(e as Error).message}`); }
  return () => { stopped = true; clearInterval(poll); watcher?.close(); };
}
