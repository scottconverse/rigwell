import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
/** Resolve the nearest existing ancestor, including symlinks above a not-yet-created output. */
export function resolvedBrowserPath(value: string): string {
  let at = resolve(value); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(at), ...suffix); } catch {
      const parent = dirname(at); if (parent === at) throw new Error("Cannot resolve browser output root");
      suffix.unshift(basename(at)); at = parent;
    }
  }
}
