// Setup profiles (spec §18.3): repo profiles (need a trusted repo) and local profiles (no trust check).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { makePrivate } from "../platform/private.ts";
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
  const found = all.find((p) => p.id === id && p.source === "local") ?? all.find((p) => p.id === id);
  if (found) return found;
  // A deleted local profile still answers with its name and cleanup script (old worktrees can be cleaned up).
  const gone = readProfileIndex(repoRoot).deleted[id];
  return gone ? { id, source: "local", name: gone.name, cleanupScript: gone.cleanupScript } : undefined;
}

// ---- index.yaml (spec 18.3): lastUsedProfileId, and name + cleanup script of deleted profiles ----

export interface ProfileIndex {
  lastUsedProfileId?: string;
  /** Deleted local profiles keep only these two fields so old worktrees can still be cleaned up. */
  deleted: Record<string, { name: string; cleanupScript?: string }>;
}

const indexFile = (repoRoot: string) => path.join(localProfilesDir(repoRoot), "index.yaml");

export function readProfileIndex(repoRoot: string): ProfileIndex {
  try {
    const doc = (Bun as any).YAML.parse(readFileSync(indexFile(repoRoot), "utf8")) as Record<string, any> | null;
    const deleted: ProfileIndex["deleted"] = {};
    for (const [id, v] of Object.entries(doc?.deleted ?? {})) {
      const d = v as Record<string, unknown>;
      if (typeof d?.name === "string") deleted[id] = { name: d.name, ...(typeof d.cleanupScript === "string" && d.cleanupScript ? { cleanupScript: d.cleanupScript } : {}) };
    }
    return { lastUsedProfileId: typeof doc?.lastUsedProfileId === "string" ? doc.lastUsedProfileId : undefined, deleted };
  } catch { return { deleted: {} }; }
}

function writeProfileIndex(repoRoot: string, idx: ProfileIndex) {
  const dir = localProfilesDir(repoRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  makePrivate(dir, { dir: true });
  const lines: string[] = [];
  if (idx.lastUsedProfileId) lines.push(`lastUsedProfileId: ${JSON.stringify(idx.lastUsedProfileId)}`);
  const ids = Object.keys(idx.deleted);
  if (ids.length) {
    lines.push("deleted:");
    for (const id of ids) {
      lines.push(`  ${JSON.stringify(id)}:`, `    name: ${JSON.stringify(idx.deleted[id]!.name)}`);
      if (idx.deleted[id]!.cleanupScript) lines.push(`    cleanupScript: ${JSON.stringify(idx.deleted[id]!.cleanupScript)}`);
    }
  }
  const f = indexFile(repoRoot);
  writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
  makePrivate(f);
}

/** Remembers the profile the user picked last for this repo. */
export function setLastUsedProfile(repoRoot: string, id: string | undefined) {
  const idx = readProfileIndex(repoRoot);
  if (idx.lastUsedProfileId === id) return;
  writeProfileIndex(repoRoot, { ...idx, lastUsedProfileId: id });
}

/** Deletes a local profile file; its name and cleanup script stay in index.yaml. False when there was no such file. */
export function deleteLocalProfile(repoRoot: string, id: string): boolean {
  const file = ["yaml", "yml"].map((e) => path.join(localProfilesDir(repoRoot), `${id}.${e}`)).find((f) => existsSync(f));
  if (!file) return false;
  const p = readDir(localProfilesDir(repoRoot), "local").find((x) => x.id === id);
  const idx = readProfileIndex(repoRoot);
  idx.deleted[id] = { name: p?.name ?? id, ...(p?.cleanupScript ? { cleanupScript: p.cleanupScript } : {}) };
  if (idx.lastUsedProfileId === id) idx.lastUsedProfileId = undefined;
  writeProfileIndex(repoRoot, idx);
  rmSync(file);
  return true;
}

/** Writes a local profile (folder 0700, file 0600). Used by tests and tooling. */
export function saveLocalProfile(repoRoot: string, p: Omit<SetupProfile, "source">): void {
  const dir = localProfilesDir(repoRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  makePrivate(dir, { dir: true });
  const lines = [`name: ${JSON.stringify(p.name)}`];
  for (const k of ["script", "initialPrompt", "cleanupScript"] as const) if (p[k]) lines.push(`${k}: ${JSON.stringify(p[k])}`);
  const f = path.join(dir, `${p.id}.yaml`);
  writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
  makePrivate(f);
}
