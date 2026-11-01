import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Creates a temp dir, points RIGWELL_HOME at <tmp>/home/.rigwell. Returns paths + cleanup. */
export function tmpEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "rigwell-st-"));
  const home = path.join(root, "home");
  const rh = path.join(home, ".rigwell");
  mkdirSync(rh, { recursive: true });
  const prev = process.env.RIGWELL_HOME;
  process.env.RIGWELL_HOME = rh;
  return {
    root, home, rigwellHome: rh,
    cleanup() {
      if (prev === undefined) delete process.env.RIGWELL_HOME; else process.env.RIGWELL_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeJson(file: string, v: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v));
}
