// Results store: $RIGWELL_HOME/eval/runs/<buildId>/<timestamp>.json
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { rigwellHome } from "../storage/paths.ts";
import type { RunRecord } from "./types.ts";

export const evalDir = () => join(rigwellHome(), "eval");
export const runsDir = () => join(evalDir(), "runs");

/** Build id: git short sha of the Rigwell checkout, or "unknown" outside a checkout. */
export function currentBuildId(checkout = join(import.meta.dir, "../..")): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function saveRun(run: RunRecord): string {
  const dir = join(runsDir(), safe(run.buildId));
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${run.startedAt.replace(/[:.]/g, "-")}.json`);
  for (let i = 1; existsSync(file); i++) file = join(dir, `${run.startedAt.replace(/[:.]/g, "-")}-${i}.json`);
  writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** All stored runs, oldest first by startedAt. Unreadable files are skipped. */
export function loadRuns(): RunRecord[] {
  const root = runsDir();
  if (!existsSync(root)) return [];
  const out: RunRecord[] = [];
  for (const b of readdirSync(root)) {
    const d = join(root, b);
    let files: string[] = [];
    try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(d, f), "utf8")) as RunRecord;
        if (r.schema === 1 && Array.isArray(r.results)) out.push(r);
      } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
