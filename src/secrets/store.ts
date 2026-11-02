// Named secrets and named environments (spec 12.2 secret fields, desktop "API keys, secrets and environments" pages).
// Secret VALUES live only in the credential store (keychain, else the 0600 file) under `secret:<name>`.
// `<home>/secrets.json` is an index of names and masks (no values) so a list does not have to open the keychain.
// `<home>/environments.json` holds environments: sets of variables, each a literal or a reference to a secret.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lookupCredential, removeCredential, storeCredential } from "../storage/credentials.ts";
import { rigwellHome } from "../storage/paths.ts";

export class SecretsError extends Error {
  constructor(readonly kind: "invalid" | "not_found" | "conflict", message: string) { super(message); this.name = "SecretsError"; }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Variables callers cannot set (the same protected set as terminals, spec 17.2). */
export const PROTECTED_ENV = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "SUDO_USER", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO"]);
export const secretKey = (name: string) => `secret:${name}`;

/** What a list shows instead of the value: "****" plus the last four characters when the value is long enough that this reveals little. */
export function maskSecret(v: string): string {
  return v.length >= 12 ? `****${v.slice(-4)}` : "****";
}

function readJson(file: string): Record<string, any> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function writeJson(file: string, v: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

const secretsFile = () => path.join(rigwellHome(), "secrets.json");
const envsFile = () => path.join(rigwellHome(), "environments.json");

// ---------- secrets ----------

export interface SecretInfo { name: string; mask: string; createdAt: number; updatedAt: number; usedBy: string[] }

function checkName(name: unknown, what = "secret"): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new SecretsError("invalid", `${what} name must be 1-64 letters, digits, '.', '_' or '-' and start with a letter or digit`);
  return name;
}

/** Names, masks and which environments use each. Never a value. */
export function listSecrets(): SecretInfo[] {
  const idx = readJson(secretsFile());
  const envs = readJson(envsFile());
  return Object.keys(idx).sort().map((name) => ({
    name, mask: String(idx[name].mask ?? "****"), createdAt: Number(idx[name].createdAt) || 0, updatedAt: Number(idx[name].updatedAt) || 0,
    usedBy: Object.keys(envs).filter((e) => Object.values<any>(envs[e]?.vars ?? {}).some((v) => v?.secret === name)).sort(),
  }));
}

export function setSecret(name: unknown, value: unknown): { name: string; mask: string; backend: string } {
  const n = checkName(name);
  if (typeof value !== "string" || !value) throw new SecretsError("invalid", "value must be a non-empty string");
  if (/[\r\n\0]/.test(value)) throw new SecretsError("invalid", "value must not contain newlines or NUL");
  const backend = storeCredential(secretKey(n), value);
  const idx = readJson(secretsFile());
  const now = Date.now();
  idx[n] = { mask: maskSecret(value), createdAt: idx[n]?.createdAt ?? now, updatedAt: now };
  writeJson(secretsFile(), idx);
  return { name: n, mask: idx[n].mask, backend };
}

export function deleteSecret(name: unknown): { deleted: boolean; usedBy: string[] } {
  const n = checkName(name);
  const usedBy = listSecrets().find((s) => s.name === n)?.usedBy ?? [];
  const idx = readJson(secretsFile());
  const had = n in idx;
  delete idx[n];
  writeJson(secretsFile(), idx);
  const removed = removeCredential(secretKey(n));
  return { deleted: had || removed, usedBy };
}

export function secretValue(name: string): string | undefined {
  return lookupCredential(secretKey(name));
}

// ---------- environments ----------

export type EnvVarSpec = string | { secret: string };
export interface EnvVarInfo { name: string; kind: "literal" | "secret"; value?: string; secret?: string; missing?: boolean }
export interface EnvironmentInfo { name: string; description?: string; vars: EnvVarInfo[]; updatedAt: number }

/** Environments for a list: literal values are shown (keep sensitive values in secrets), secret references show only the secret's name. */
export function listEnvironments(): EnvironmentInfo[] {
  const envs = readJson(envsFile());
  const have = new Set(Object.keys(readJson(secretsFile())));
  return Object.keys(envs).sort().map((name) => ({
    name, ...(envs[name].description ? { description: String(envs[name].description) } : {}), updatedAt: Number(envs[name].updatedAt) || 0,
    vars: Object.keys(envs[name].vars ?? {}).sort().map((k): EnvVarInfo => {
      const v = envs[name].vars[k];
      return typeof v?.secret === "string" ? { name: k, kind: "secret", secret: v.secret, missing: !have.has(v.secret) } : { name: k, kind: "literal", value: String(v?.value ?? "") };
    }),
  }));
}

export function setEnvironment(name: unknown, vars: unknown, description?: unknown): EnvironmentInfo {
  const n = checkName(name, "environment");
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new SecretsError("invalid", "vars must be an object of NAME: value or NAME: {secret: \"name\"}");
  if (description !== undefined && typeof description !== "string") throw new SecretsError("invalid", "description must be a string");
  const stored: Record<string, { value: string } | { secret: string }> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!VAR.test(k)) throw new SecretsError("invalid", `invalid variable name ${JSON.stringify(k)}`);
    if (PROTECTED_ENV.has(k)) throw new SecretsError("invalid", `${k} is protected and cannot be set`);
    if (typeof v === "string") { if (v.includes("\0")) throw new SecretsError("invalid", `${k}: value must not contain NUL`); stored[k] = { value: v }; }
    else if (v && typeof v === "object" && typeof (v as any).secret === "string") stored[k] = { secret: checkName((v as any).secret) };
    else throw new SecretsError("invalid", `${k}: use a string or {secret: "name"}`);
  }
  const all = readJson(envsFile());
  all[n] = { ...(description ? { description } : {}), vars: stored, updatedAt: Date.now() };
  writeJson(envsFile(), all);
  return listEnvironments().find((e) => e.name === n)!;
}

export function deleteEnvironment(name: unknown): { deleted: boolean } {
  const n = checkName(name, "environment");
  const all = readJson(envsFile());
  const had = n in all;
  delete all[n];
  if (had) writeJson(envsFile(), all);
  return { deleted: had };
}

export interface ResolvedEnvironment {
  name: string;
  /** Variables to inject into Execute and hook processes. */
  env: Record<string, string>;
  /** Secret values by secret name, for redaction. */
  secrets: Record<string, string>;
}

/** The values behind an environment. Throws when it does not exist or references a missing secret. */
export function resolveEnvironment(name: string): ResolvedEnvironment {
  const all = readJson(envsFile());
  const e = all[name];
  if (!e) throw new SecretsError("not_found", `No environment named ${JSON.stringify(name)}`);
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(e.vars ?? {})) {
    if (typeof v?.secret === "string") {
      const val = secretValue(v.secret);
      if (val === undefined) throw new SecretsError("invalid", `Environment ${JSON.stringify(name)} uses secret ${JSON.stringify(v.secret)}, which is not stored`);
      env[k] = val;
      secrets[v.secret] = val;
    } else env[k] = String(v?.value ?? "");
  }
  return { name, env, secrets };
}

/** Replaces every secret value in `text` with `[secret:<name>]`. Values under 4 characters are not replaced (too many false hits). */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, v] of Object.entries(secrets).sort((a, b) => b[1].length - a[1].length)) {
    if (v.length >= 4 && out.includes(v)) out = out.split(v).join(`[secret:${name}]`);
  }
  return out;
}
