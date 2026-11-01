// Side pane Files tab, daemon side (spec §17.1): list, search, read and write workspace files.
// Writes are guarded by a content fingerprint (sha256) so an edit made on a stale copy is refused with -32006.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";

export const MAX_LIST_FILES = 25_000;
export const MAX_LIST_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".ts": "text/typescript", ".tsx": "text/typescript", ".js": "text/javascript", ".jsx": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".html": "text/html", ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain", ".py": "text/x-python",
  ".rs": "text/x-rust", ".go": "text/x-go", ".sh": "text/x-shellscript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export const mimeFor = (file: string) => MIME[extname(file).toLowerCase()] ?? "application/octet-stream";

export const fingerprintOf = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

const bad = (msg: string, reason?: string) => new RpcError(ErrorCodes.INVALID_PARAMS, msg, reason ? { reason } : undefined);

/** A relative path with no drive letter, leading slash or dot segment. "" and undefined mean the root. */
export function validateRelative(p: unknown): string {
  if (p === undefined || p === null || p === "") return "";
  if (typeof p !== "string") throw bad("path must be a string");
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) throw bad("path must be relative");
  if (p.split(/[\\/]/).some((s) => s === ".." || s === ".")) throw bad("path must not contain . or .. segments");
  return p;
}

/** Resolves `rel` inside `cwd` (real paths, so a symlink cannot escape). Returns the absolute real path. */
export function resolveInside(cwd: string, rel: string): string {
  const root = realpathSync(cwd);
  const abs = resolve(root, rel);
  let real: string;
  try { real = realpathSync(abs); } catch { throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `Not found: ${rel}`); }
  if (real !== root && !real.startsWith(root + sep)) throw bad("path is outside the working folder", "outside_cwd");
  return real;
}

function walk(root: string, dir: string, showHidden: boolean, out: string[], dirs: Set<string>, budget: { bytes: number; truncated: boolean }) {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.truncated) return;
    if (!showHidden && e.name.startsWith(".")) continue;
    if (e.name === "node_modules" || e.name === ".git") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { dirs.add(rel); walk(root, rel, showHidden, out, dirs, budget); }
    else if (e.isFile() || e.isSymbolicLink()) {
      if (out.length >= MAX_LIST_FILES || budget.bytes + rel.length > MAX_LIST_BYTES) { budget.truncated = true; return; }
      out.push(rel); budget.bytes += rel.length;
    }
  }
}

/** All files under `path` (relative to cwd), honoring .gitignore through ripgrep when it is installed. */
export function listFiles(cwd: string, p: { path?: unknown; showHidden?: unknown }) {
  const sub = validateRelative(p.path);
  const base = sub ? resolveInside(cwd, sub) : realpathSync(cwd);
  if (!statSync(base).isDirectory()) throw bad("path is not a folder");
  const showHidden = p.showHidden === true;
  const files: string[] = [];
  let truncated = false;
  const dirs = new Set<string>();
  const rg = Bun.which("rg");
  if (rg) {
    const args = ["--files", "--sort", "path", ...(showHidden ? ["--hidden", "--glob", "!.git"] : [])];
    const r = Bun.spawnSync([rg, ...args], { cwd: base, stdout: "pipe", stderr: "ignore" });
    // rg exits 1 when nothing matches; 2 on errors (a failed listing is an empty list, spec §17.1).
    if (r.exitCode === 0 || r.exitCode === 1) {
      let bytes = 0;
      for (const line of r.stdout.toString().split("\n")) {
        if (!line) continue;
        if (files.length >= MAX_LIST_FILES || bytes + line.length > MAX_LIST_BYTES) { truncated = true; break; }
        files.push(line); bytes += line.length;
      }
    }
  } else {
    const budget = { bytes: 0, truncated: false };
    walk(base, "", showHidden, files, dirs, budget);
    truncated = budget.truncated;
  }
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const prefix = sub ? sub.replace(/\\/g, "/").replace(/\/$/, "") + "/" : "";
  return {
    files: files.map((f) => prefix + f),
    totalFiles: files.length,
    ...(truncated ? { truncated: true } : {}),
    directories: [...dirs].sort().map((d) => prefix + d),
  };
}

/** Subsequence match with a score: basename hits rank first, then runs of consecutive letters. -1 = no match. */
export function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  const s = path.toLowerCase();
  if (!q) return 0;
  const base = s.slice(s.lastIndexOf("/") + 1);
  if (base.includes(q)) return 1000 - base.indexOf(q) * 2 - s.length * 0.01;
  if (s.includes(q)) return 800 - s.indexOf(q) - s.length * 0.01;
  let i = 0, score = 0, run = 0;
  for (const ch of s) {
    if (ch === q[i]) { i++; run++; score += 2 + run; } else run = 0;
    if (i === q.length) break;
  }
  return i === q.length ? score - s.length * 0.01 : -1;
}

export function searchFiles(cwd: string, p: { query?: unknown; maxResults?: unknown; showHidden?: unknown }) {
  if (typeof p.query !== "string") throw bad("query is required");
  const max = typeof p.maxResults === "number" && p.maxResults > 0 ? Math.floor(p.maxResults) : 60;
  const all = listFiles(cwd, { showHidden: p.showHidden }).files;
  const scored = all.map((f) => ({ f, s: fuzzyScore(p.query as string, f) })).filter((x) => x.s >= 0);
  scored.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));
  return { files: scored.slice(0, max).map((x) => x.f), totalFiles: scored.length };
}

function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Reads may go outside the working folder by absolute path (the session owner is the user); writes may not. */
function fileTarget(cwd: string, filePath: unknown, allowOutside: boolean): string {
  if (typeof filePath !== "string" || !filePath) throw bad("filePath is required");
  if (allowOutside && isAbsolute(filePath)) {
    if (!existsSync(filePath)) throw new RpcError(ErrorCodes.ENTITY_NOT_FOUND, `Not found: ${filePath}`);
    return realpathSync(filePath);
  }
  return resolveInside(cwd, validateRelative(filePath));
}

export function readWorkspaceFile(cwd: string, p: { filePath?: unknown; metadataOnly?: unknown; allowDirectory?: unknown; encoding?: unknown }) {
  const abs = fileTarget(cwd, p.filePath, true);
  const st = statSync(abs);
  const rel = relative(realpathSync(cwd), abs);
  if (st.isDirectory()) {
    if (p.allowDirectory !== true) throw bad("path is a folder");
    return { filePath: rel, isDirectory: true, entries: readdirSync(abs).sort() };
  }
  if (st.size > MAX_FILE_BYTES) throw new RpcError(ErrorCodes.INVALID_PARAMS, "File is larger than 15 MB", { reason: "too_large", byteLength: st.size });
  const buf = new Uint8Array(readFileSync(abs));
  const isBinary = looksBinary(buf);
  const meta = { filePath: rel, byteLength: buf.length, mimeType: mimeFor(abs), isBinary, fingerprint: fingerprintOf(buf), mtimeMs: st.mtimeMs };
  if (p.metadataOnly === true) return meta;
  if (isBinary && p.encoding !== "base64") return meta;
  const content = p.encoding === "base64" ? Buffer.from(buf).toString("base64") : new TextDecoder().decode(buf);
  return { ...meta, content, encoding: p.encoding === "base64" ? "base64" : "utf8" };
}

/** Writes an existing text file. `baseFingerprint` is the fingerprint the editor started from. */
export function writeWorkspaceFile(cwd: string, p: { filePath?: unknown; content?: unknown; baseFingerprint?: unknown }) {
  if (typeof p.content !== "string") throw bad("content is required");
  const abs = fileTarget(cwd, p.filePath, false);
  const st = statSync(abs);
  if (!st.isFile()) throw bad("path is not a file");
  const bytes = new TextEncoder().encode(p.content);
  if (bytes.length > MAX_FILE_BYTES) throw bad("content is larger than 15 MB", "too_large");
  const current = new Uint8Array(readFileSync(abs));
  if (looksBinary(current)) throw bad("binary files cannot be edited here", "binary");
  const now = fingerprintOf(current);
  if (typeof p.baseFingerprint === "string" && p.baseFingerprint !== now) {
    throw new RpcError(ErrorCodes.CONFLICT, "The file changed since the edit started", { reason: "stale", currentFingerprint: now });
  }
  // Write to a sibling temp file and rename so a crash cannot leave a half-written file; keep the mode.
  const tmp = join(dirname(abs), `.${Date.now().toString(36)}-${process.pid}.rigwell-tmp`);
  try {
    writeFileSync(tmp, bytes);
    chmodSync(tmp, st.mode & 0o7777);
    renameSync(tmp, abs);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  return { byteLength: bytes.length, fingerprint: fingerprintOf(bytes) };
}
