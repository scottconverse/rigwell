// Credential store (spec 12.2): custom-model API keys in the OS keychain where possible, else a 0600 file.
// Settings reference a stored key as `apiKey: "keychain:<name>"`. A plain `apiKey` in settings keeps working.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rigwellHome } from "./paths.ts";

export const KEYCHAIN_PREFIX = "keychain:";
const SERVICE = "rigwell";

/** Runs a command. `input` goes to its stdin. Never throws: a missing program is code 127. */
export type CommandRunner = (cmd: string[], input?: string) => { code: number; stdout: string };

export const spawnRunner: CommandRunner = (cmd, input) => {
  try {
    const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
  } catch {
    return { code: 127, stdout: "" };
  }
};

export interface CredentialBackend {
  readonly name: string;
  available(): boolean;
  get(account: string): string | undefined;
  /** Returns false when the value could not be stored here. */
  set(account: string, value: string): boolean;
  delete(account: string): boolean;
}

/** macOS Keychain through the `security` tool. The value is passed as an argument (visible to `ps` for an instant). */
export class MacKeychainBackend implements CredentialBackend {
  readonly name = "macos-keychain";
  constructor(private run: CommandRunner = spawnRunner, private has: () => boolean = () => !!Bun.which("security")) {}
  available() { return this.has(); }
  get(account: string) {
    const r = this.run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
    return r.code === 0 && r.stdout.length ? r.stdout.replace(/\r?\n$/, "") : undefined;
  }
  set(account: string, value: string) {
    return this.run(["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value]).code === 0;
  }
  delete(account: string) {
    return this.run(["security", "delete-generic-password", "-s", SERVICE, "-a", account]).code === 0;
  }
}

/** Linux Secret Service (libsecret) through `secret-tool`. The value goes over stdin. */
export class SecretToolBackend implements CredentialBackend {
  readonly name = "libsecret";
  constructor(private run: CommandRunner = spawnRunner, private has: () => boolean = () => !!Bun.which("secret-tool")) {}
  available() { return this.has(); }
  get(account: string) {
    const r = this.run(["secret-tool", "lookup", "service", SERVICE, "account", account]);
    return r.code === 0 && r.stdout.length ? r.stdout : undefined;
  }
  set(account: string, value: string) {
    return this.run(["secret-tool", "store", `--label=Rigwell ${account}`, "service", SERVICE, "account", account], value).code === 0;
  }
  delete(account: string) {
    return this.run(["secret-tool", "clear", "service", SERVICE, "account", account]).code === 0;
  }
}

/** `$RIGWELL_HOME/credentials.json`, mode 0600. The fallback when no keychain is usable. */
export class FileBackend implements CredentialBackend {
  readonly name = "file";
  constructor(private file: () => string = () => path.join(rigwellHome(), "credentials.json")) {}
  available() { return true; }
  private read(): Record<string, string> {
    try {
      const j = JSON.parse(readFileSync(this.file(), "utf8"));
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch { return {}; }
  }
  private write(all: Record<string, string>) {
    const f = this.file();
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, f);
    } finally { rmSync(tmp, { force: true }); }
  }
  get(account: string) { const v = this.read()[account]; return typeof v === "string" ? v : undefined; }
  set(account: string, value: string) { this.write({ ...this.read(), [account]: value }); return true; }
  delete(account: string) {
    const all = this.read();
    if (!(account in all)) return false;
    delete all[account];
    this.write(all);
    return true;
  }
  names(): string[] { return Object.keys(this.read()); }
}

/** Tries each backend in order: keychains first, the file last. */
export class CredentialStore {
  constructor(readonly backends: CredentialBackend[]) {}

  get(name: string): string | undefined {
    for (const b of this.backends) {
      if (!b.available()) continue;
      const v = b.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** Stores in the first backend that accepts it; returns that backend's name. */
  set(name: string, value: string): string {
    for (const b of this.backends) {
      if (!b.available()) continue;
      try { if (b.set(name, value)) return b.name; } catch { /* next backend */ }
    }
    throw new Error("no credential backend could store the value");
  }

  /** Removes the credential everywhere it is held. */
  delete(name: string): boolean {
    let any = false;
    for (const b of this.backends) {
      if (!b.available()) continue;
      try { any = b.delete(name) || any; } catch { /* ignore */ }
    }
    return any;
  }
}

/** The store for this machine: macOS Keychain or libsecret when present, then the 0600 file. RIGWELL_CREDENTIALS=file skips the keychains. */
export function defaultCredentialStore(platform: string = process.platform, run: CommandRunner = spawnRunner): CredentialStore {
  const backends: CredentialBackend[] = [];
  if (process.env.RIGWELL_CREDENTIALS !== "file") {
    if (platform === "darwin") backends.push(new MacKeychainBackend(run));
    else if (platform === "linux") backends.push(new SecretToolBackend(run));
  }
  backends.push(new FileBackend());
  return new CredentialStore(backends);
}

// ---------- lookups for settings ----------

let shared: CredentialStore | undefined;
const cache = new Map<string, { value: string | undefined; at: number }>();
const TTL_MS = 30_000;

/** Replaces the store `resolveCredential` uses (tests). Pass undefined to go back to the default. */
export function setCredentialStore(s: CredentialStore | undefined) { shared = s; cache.clear(); }
export function clearCredentialCache() { cache.clear(); }

/** The value behind `keychain:<name>`, or undefined. Keychain lookups run a program, so results are cached for 30 s. */
export function lookupCredential(name: string): string | undefined {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = (shared ??= defaultCredentialStore()).get(name);
  cache.set(name, { value, at: Date.now() });
  return value;
}

export function storeCredential(name: string, value: string): string {
  const where = (shared ??= defaultCredentialStore()).set(name, value);
  cache.delete(name);
  return where;
}

export function removeCredential(name: string): boolean {
  const ok = (shared ??= defaultCredentialStore()).delete(name);
  cache.delete(name);
  return ok;
}
