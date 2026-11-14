import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

export type SyncTarget = { kind: "folder"; path: string; replicated?: true } | { kind: "git"; remote: string; private: true };
export interface SyncItem { key: string; owner: string; hash: string; revision?: string; parent?: string; updatedAt: number; files: Record<string, string> }
export interface SyncDocument { version: 1; items: Record<string, SyncItem>; conflicts: SyncItem[]; leases: Record<string, { owner: string; token: string; expiresAt: number }> }
export const emptyDocument = (): SyncDocument => ({ version: 1, items: {}, conflicts: [], leases: {} });
const MAX = 64 * 1024 * 1024;
export const hashFiles = (files: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
export function parseDocument(text: string): SyncDocument {
  if (Buffer.byteLength(text) > MAX) throw new Error("Sync target exceeds 64 MiB");
  const d = JSON.parse(text);
  if (d?.version !== 1 || !d.items || !Array.isArray(d.conflicts) || !d.leases) throw new Error("Invalid sync target");
  for (const item of [...Object.values(d.items), ...d.conflicts] as any[]) {
    if (!item || !/^(session|automation|mission|workstream|settings)\/[a-zA-Z0-9_-]+$/.test(item.key) || typeof item.owner !== "string" || !/^[a-f0-9]{64}$/.test(item.hash) || !Number.isFinite(item.updatedAt) || !item.files || Array.isArray(item.files)) throw new Error("Invalid synced item");
    for (const [name, value] of Object.entries(item.files)) if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith(".") || typeof value !== "string") throw new Error("Invalid synced file");
    if (hashFiles(item.files) !== item.hash) throw new Error("Synced item hash does not match its content");
  }
  for (const [key, item] of Object.entries(d.items) as [string, SyncItem][]) if (key !== item.key) throw new Error("Synced item key mismatch");
  for (const lease of Object.values(d.leases) as any[]) if (!lease || typeof lease.owner !== "string" || typeof lease.token !== "string" || !Number.isFinite(lease.expiresAt)) throw new Error("Invalid session lease");
  return d;
}
/** Refuse existing links in every component, including Windows junctions. */
export function unlinkedPath(file: string) {
  const full = resolve(file); let p = full;
  for (;;) {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        // macOS ships these root aliases. They are not user-controlled storage links.
        const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(p) && readlinkSync(p) === `private${p}`;
        if (!systemAlias) throw new Error(`Sync paths cannot contain links: ${p}`);
      }
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parent = dirname(p); if (p === parent) break; p = parent;
  }
  return full;
}
export function atomicText(file: string, text: string) {
  unlinkedPath(file); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, text, { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const p = Bun.spawn(["git", "-c", "core.hooksPath=", "-c", "credential.interactive=never", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", ...args], {
    cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes", GIT_AUTHOR_NAME: "Rigwell sync", GIT_AUTHOR_EMAIL: "sync@localhost", GIT_COMMITTER_NAME: "Rigwell sync", GIT_COMMITTER_EMAIL: "sync@localhost" },
    stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => p.kill(), 20_000);
  try {
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code) throw new Error(`Sync git ${args[0]} failed: ${err.slice(0, 1000)}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}
const queues = new Map<string, Promise<unknown>>();
export class SyncRepository {
  constructor(readonly target: SyncTarget, readonly cache: string) {}
  /** Folder targets must be one authoritative filesystem, not independently writable replicas. */
  async transaction<T>(change: (d: SyncDocument) => T): Promise<T> {
    const root = unlinkedPath(this.target.kind === "folder" ? join(this.target.path, ".rigwell-sync") : this.cache);
    const previous = queues.get(root);
    const pending = (async () => { await previous?.catch(() => {}); return this.performTransaction(root, change); })();
    queues.set(root, pending);
    try { return await pending; } finally { if (queues.get(root) === pending) queues.delete(root); }
  }
  private async performTransaction<T>(root: string, change: (d: SyncDocument) => T): Promise<T> {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (this.target.kind === "folder" && this.target.replicated) {
      // Immutable uniquely named packets survive an asynchronous folder replicator's merge.
      // They never serve as a lease authority.
      const merged = emptyDocument(), versions = new Map<string, Map<string, SyncItem>>(); let size = 0;
      for (const name of readdirSync(root).filter((n) => /^packet-[a-f0-9-]+\.json$/.test(n)).sort()) {
        const file = unlinkedPath(join(root, name)); size += lstatSync(file).size; if (size > MAX) throw new Error("Replicated sync packets exceed 64 MiB");
        const document = parseDocument(readFileSync(file, "utf8"));
        for (const item of [...Object.values(document.items), ...document.conflicts]) {
          const all = versions.get(item.key) ?? new Map<string, SyncItem>(), revision = item.revision ?? item.hash, old = all.get(revision);
          if (!old || item.updatedAt > old.updatedAt) all.set(revision, item);
          versions.set(item.key, all);
        }
      }
      for (const [key, all] of versions) {
        const ancestors = new Set([...all.values()].map((i) => i.parent).filter(Boolean));
        const tips = [...all.values()].filter((i) => !ancestors.has(i.revision ?? i.hash)).sort((a, b) => b.updatedAt - a.updatedAt || b.hash.localeCompare(a.hash));
        if (!tips.length) throw new Error("Invalid sync revision cycle");
        merged.items[key] = tips[0]!; const hashes = new Set([tips[0]!.hash]);
        for (const tip of tips.slice(1)) if (!hashes.has(tip.hash)) { merged.conflicts.push(tip); hashes.add(tip.hash); }
      }
      const before = JSON.stringify(merged), result = change(merged), text = JSON.stringify(merged); parseDocument(text);
      if (Object.keys(merged.leases).length) throw new Error("Replicated folders cannot arbitrate session leases");
      if (text !== before) atomicText(join(root, `packet-${randomUUID()}.json`), text); return result;
    }
    // An OS-released database lock survives process crashes without a stale lock directory.
    // The chosen shared filesystem must support SQLite file locking.
    const lockPath = unlinkedPath(join(root, "coordinator.db")), lock = new Database(lockPath);
    lock.exec("PRAGMA busy_timeout=2000");
    try { lock.exec("BEGIN IMMEDIATE"); } catch (e) { lock.close(); throw e; }
    try {
      if (this.target.kind === "folder") {
        const file = join(root, "sync.json"); unlinkedPath(file);
        let d: SyncDocument;
        try { d = parseDocument(readFileSync(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; d = emptyDocument(); }
        const result = change(d); const text = JSON.stringify(d); parseDocument(text); atomicText(file, text); return result;
      }
      await git(root, ["init", "--quiet"]);
      const remote = this.target.remote;
      // A dedicated ref and commit-tree avoid checking out or executing remote files/hooks.
      for (let attempt = 0; attempt < 4; attempt++) {
        const refs = await git(root, ["ls-remote", "--", remote, "refs/heads/rigwell-sync-v1"]);
        const base = refs.split(/\s/)[0] || undefined;
        let d = emptyDocument();
        if (base) {
          await git(root, ["fetch", "--quiet", "--no-tags", "--", remote, "refs/heads/rigwell-sync-v1"]);
          d = parseDocument(await git(root, ["show", `${base}:sync.json`]));
        }
        const before = JSON.stringify(d), result = change(d), text = JSON.stringify(d); parseDocument(text);
        if (text === before) return result;
        const blob = await git(root, ["hash-object", "-w", "--stdin"], text);
        const tree = await git(root, ["mktree"], `100644 blob ${blob}\tsync.json\n`);
        const commit = await git(root, ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", "Update private sync state"]);
        try { await git(root, ["push", "--quiet", `--force-with-lease=refs/heads/rigwell-sync-v1:${base ?? ""}`, "--", remote, `${commit}:refs/heads/rigwell-sync-v1`]); return result; }
        catch (e) {
          const current = await git(root, ["ls-remote", "--", remote, "refs/heads/rigwell-sync-v1"]);
          if (current === refs || attempt === 3) throw e; // Only retry a proven compare-and-swap conflict.
        }
      }
      throw new Error("Sync target changed repeatedly");
    } finally { lock.exec("ROLLBACK"); lock.close(); }
  }
}
