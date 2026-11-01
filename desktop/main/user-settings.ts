// The agent's user settings file (<home>/settings.json, spec §12.2) as the desktop settings pages edit it.
// The daemon has no settings RPC, so the main process reads and writes the file itself. Secrets never reach the page in
// clear text (spec §12.2): API keys and header values are masked on the way out, and a masked value that comes back
// unchanged means "keep what is on disk".
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MASK_PREFIX = "****";
type Json = Record<string, any>;

const isRef = (v: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
/** A value that is shown instead of a secret. Environment references stay readable: they are not secrets. */
export function maskSecret(v: unknown): unknown {
  if (typeof v !== "string" || !v || isRef(v)) return v;
  return MASK_PREFIX + v.slice(-4);
}
export const isMasked = (v: unknown) => typeof v === "string" && v.startsWith(MASK_PREFIX);

export function maskSettings(s: Json): Json {
  const out = structuredClone(s);
  if (Array.isArray(out.customModels)) {
    for (const m of out.customModels) {
      if (!m || typeof m !== "object") continue;
      if (m.apiKey !== undefined) m.apiKey = maskSecret(m.apiKey);
      if (m.extraHeaders && typeof m.extraHeaders === "object") for (const k of Object.keys(m.extraHeaders)) m.extraHeaders[k] = maskSecret(m.extraHeaders[k]);
    }
  }
  return out;
}

export const settingsFile = (home: string) => join(home, "settings.json");

export function readRawSettings(home: string): Json {
  try {
    const j = JSON.parse(readFileSync(settingsFile(home), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readUserSettings(home: string): Json { return maskSettings(readRawSettings(home)); }

/** Puts back the real secret wherever the page sent the mask back unchanged. */
function restoreSecrets(next: Json[], old: Json[]) {
  for (const m of next) {
    if (!m || typeof m !== "object") continue;
    const before = old.find((o) => o && o.model === m.model && o.baseUrl === m.baseUrl) ?? old.find((o) => o && o.model === m.model);
    if (isMasked(m.apiKey)) { if (before?.apiKey !== undefined) m.apiKey = before.apiKey; else delete m.apiKey; }
    if (m.extraHeaders && typeof m.extraHeaders === "object") {
      for (const k of Object.keys(m.extraHeaders)) {
        if (!isMasked(m.extraHeaders[k])) continue;
        if (before?.extraHeaders?.[k] !== undefined) m.extraHeaders[k] = before.extraHeaders[k]; else delete m.extraHeaders[k];
      }
    }
  }
}

const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

/** Top-level keys in `patch` replace the file's keys; `null` removes a key. Returns the masked result. */
export function updateUserSettings(home: string, patch: unknown): Json {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object");
  const cur = readRawSettings(home);
  for (const [k, v] of Object.entries(patch as Json)) {
    if (BLOCKED.has(k)) continue;
    if (v === null) { delete cur[k]; continue; }
    if (k === "customModels" && Array.isArray(v)) {
      const next = structuredClone(v) as Json[];
      restoreSecrets(next, Array.isArray(cur.customModels) ? cur.customModels : []);
      cur.customModels = next;
      continue;
    }
    cur[k] = v;
  }
  atomicWrite(settingsFile(home), JSON.stringify(cur, null, 2) + "\n");
  return maskSettings(cur);
}

/** Records a folder as trusted (spec §5.6) after the user accepted the prompt. */
export function trustFolder(home: string, folder: string): Json {
  const p = resolve(folder);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`Not a folder: ${p}`);
  const cur = readRawSettings(home);
  const map = { ...(cur.trustedFolders ?? {}), [p]: { trustedAt: Date.now() } };
  return updateUserSettings(home, { trustedFolders: map });
}

// ------------------------------------------------------------------ worktree setup profiles (spec §18.3)

export interface ProfileView { id: string; source: "repository" | "local"; name: string; script?: string; initialPrompt?: string; cleanupScript?: string }

export const localProfilesDirFor = (home: string, repoRoot: string) => join(home, "worktree-setups", createHash("sha256").update(repoRoot).digest("hex"));
export const repoProfilesDirFor = (repoRoot: string) => join(repoRoot, ".rigwell", "worktree-setups");

/** Just enough YAML for profiles: `key: value`, quoted values, and `key: |` blocks. JSON (valid YAML) is tried first. */
export function parseProfileText(text: string): Json | null {
  try { const j = JSON.parse(text); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch { /* not JSON */ }
  const out: Json = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (/^[|>][+-]?$/.test(rest.trim())) {
      const block: string[] = [];
      let indent = -1;
      while (i + 1 < lines.length && (lines[i + 1] === "" || /^\s/.test(lines[i + 1]))) {
        const l = lines[++i];
        if (indent < 0 && l.trim()) indent = l.length - l.trimStart().length;
        block.push(indent > 0 ? l.slice(Math.min(indent, l.length - l.trimStart().length)) : l);
      }
      out[key] = block.join("\n").replace(/\n+$/, "") + "\n";
    } else {
      const v = rest.trim();
      out[key] = /^".*"$/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v.slice(1, -1); } })() : /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
    }
  }
  return Object.keys(out).length ? out : null;
}

function readProfiles(dir: string, source: ProfileView["source"]): ProfileView[] {
  if (!existsSync(dir)) return [];
  const out: ProfileView[] = [];
  for (const n of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x) && x !== "index.yaml").sort().slice(0, 50)) {
    try {
      const d = parseProfileText(readFileSync(join(dir, n), "utf8"));
      if (!d || typeof d.name !== "string" || !d.name.trim()) continue;
      const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      out.push({ id: n.replace(/\.ya?ml$/, ""), source, name: d.name.trim(), script: s(d.script), initialPrompt: s(d.initialPrompt), cleanupScript: s(d.cleanupScript) });
    } catch { /* skip */ }
  }
  return out;
}

export const listProfileViews = (home: string, repoRoot: string): ProfileView[] => [...readProfiles(repoProfilesDirFor(repoRoot), "repository"), ...readProfiles(localProfilesDirFor(home, repoRoot), "local")];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** Saves a local profile (never a repository one). Returns its id. */
export function saveLocalProfile(home: string, repoRoot: string, p: { id?: string; name: string; script?: string; initialPrompt?: string; cleanupScript?: string }): string {
  const name = (p.name ?? "").trim();
  if (!name || name.length > 100) throw new Error("A profile needs a name of 1 to 100 characters");
  if (!p.script?.trim() && !p.initialPrompt?.trim() && !p.cleanupScript?.trim()) throw new Error("A profile needs a setup script, an initial prompt or a cleanup script");
  const id = p.id && /^[A-Za-z0-9_-]+$/.test(p.id) ? p.id : slug(name) || "profile";
  const body = { name, ...(p.script?.trim() ? { script: p.script } : {}), ...(p.initialPrompt?.trim() ? { initialPrompt: p.initialPrompt } : {}), ...(p.cleanupScript?.trim() ? { cleanupScript: p.cleanupScript } : {}) };
  atomicWrite(join(localProfilesDirFor(home, repoRoot), `${id}.yaml`), JSON.stringify(body, null, 2) + "\n");
  return id;
}

export function deleteLocalProfile(home: string, repoRoot: string, id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid profile id");
  rmSync(join(localProfilesDirFor(home, repoRoot), `${id}.yaml`), { force: true });
}

export function gitRoot(folder: string): Promise<string | null> {
  return new Promise((res) => execFile("git", ["rev-parse", "--show-toplevel"], { cwd: folder }, (err, out) => res(err ? null : out.trim() || null)));
}
