// Trusted-folder bookkeeping for worktree folders (spec 18.1 "mark the folder trusted", 18.5 "forget trust").
// Writes `trustedFolders` in the user settings.json ($RIGWELL_HOME), keeping every other key.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rigwellHome } from "../storage/paths.ts";

function change(edit: (folders: Record<string, { trustedAt?: number | string }>) => boolean) {
  const file = path.join(rigwellHome(), "settings.json");
  let cur: Record<string, any> = {};
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) cur = j;
  } catch { /* new file */ }
  const folders = { ...(cur.trustedFolders ?? {}) };
  if (!edit(folders)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...cur, trustedFolders: folders }, null, 2) + "\n");
  renameSync(tmp, file);
}

export function markTrusted(folder: string, now = Date.now()) {
  const key = path.resolve(folder);
  change((f) => { if (f[key]) return false; f[key] = { trustedAt: now }; return true; });
}

export function forgetTrusted(folder: string) {
  const key = path.resolve(folder);
  change((f) => { if (!f[key]) return false; delete f[key]; return true; });
}
