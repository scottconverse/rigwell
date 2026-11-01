// Setup profiles (spec §18.3): repo profiles (need a trusted repo) and local profiles (no trust check).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export interface SetupProfile {
  /** File name without extension. */
  id: string;
  source: "repository" | "local";
  name: string;
  script?: string;
  initialPrompt?: string;
  cleanupScript?: string;
}

const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FIELD = 100_000;

export function localProfilesDir(repoRoot: string): string {
  return path.join(rigwellHome(), "worktree-setups", createHash("sha256").update(repoRoot).digest("hex"));
}
export function repoProfilesDir(repoRoot: string): string {
  return path.join(repoRoot, ".rigwell", "worktree-setups");
}

/** Validates a parsed YAML document; returns null when it is not a usable profile. */
export function validateProfile(id: string, source: SetupProfile["source"], doc: unknown): SetupProfile | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD ? v : undefined);
  const name = typeof d.name === "string" ? d.name.trim() : "";
  if (name.length < 1 || name.length > 100) return null;
  const p: SetupProfile = { id, source, name, script: str(d.script), initialPrompt: str(d.initialPrompt), cleanupScript: str(d.cleanupScript) };
  return p.script || p.initialPrompt || p.cleanupScript ? p : null;
}

function readDir(dir: string, source: SetupProfile["source"]): SetupProfile[] {
  if (!existsSync(dir)) return [];
  const out: SetupProfile[] = [];
  const names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && n !== "index.yaml").sort().slice(0, MAX_FILES);
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (statSync(f).size > MAX_FILE_BYTES) continue;
      const p = validateProfile(n.replace(/\.ya?ml$/, ""), source, (Bun as any).YAML.parse(readFileSync(f, "utf8")));
      if (p) out.push(p);
    } catch { /* unreadable or invalid YAML: skip */ }
  }
  return out;
}

export function listProfiles(repoRoot: string): SetupProfile[] {
  return [...readDir(repoProfilesDir(repoRoot), "repository"), ...readDir(localProfilesDir(repoRoot), "local")];
}

/** Finds a profile by id; local wins over repository on a clash. */
export function findProfile(repoRoot: string, id: string): SetupProfile | undefined {
  const all = listProfiles(repoRoot);
  return all.find((p) => p.id === id && p.source === "local") ?? all.find((p) => p.id === id);
}

/** Writes a local profile (folder 0700, file 0600). Used by tests and tooling. */
export function saveLocalProfile(repoRoot: string, p: Omit<SetupProfile, "source">): void {
  const dir = localProfilesDir(repoRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lines = [`name: ${JSON.stringify(p.name)}`];
  for (const k of ["script", "initialPrompt", "cleanupScript"] as const) if (p[k]) lines.push(`${k}: ${JSON.stringify(p[k])}`);
  const f = path.join(dir, `${p.id}.yaml`);
  writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
}
