// Machine definitions contain connection metadata, never passwords or private key contents.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, win32 } from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export type RemotePlatform = "win32" | "linux" | "darwin";
export interface Machine {
  name: string;
  host: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  platform?: RemotePlatform;
  build?: string;
  version?: string;
  bootstrappedAt?: string;
  root?: string;
  daemonPid?: number;
  lastSeen?: string;
}
export function machineDefinition(input: unknown): Machine {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid machine definition");
  const m = input as Record<string, unknown>;
  if (typeof m.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(m.name) || ["local", "default"].includes(m.name.toLowerCase())) throw new Error("Invalid or reserved machine name");
  // Keep SSH destinations out of option, URI and shell syntax. Bracketed IPv6 is accepted.
  if (typeof m.host !== "string" || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(m.host)) throw new Error("Expected an SSH host or user@host");
  const out: Machine = { name: m.name, host: m.host };
  if (m.port !== undefined) {
    if (!Number.isInteger(m.port) || Number(m.port) < 1 || Number(m.port) > 65535) throw new Error("Invalid SSH port");
    out.port = m.port as number;
  }
  for (const key of ["identityFile", "knownHostsFile"] as const) {
    if (m[key] === undefined) continue;
    if (typeof m[key] !== "string" || !isAbsolute(m[key]) || /[\r\n\0]/.test(m[key])) throw new Error(`${key} must be an absolute path`);
    out[key] = m[key];
  }
  if (m.platform !== undefined) {
    if (!["win32", "linux", "darwin"].includes(String(m.platform))) throw new Error("Invalid remote platform");
    out.platform = m.platform as RemotePlatform;
  }
  if (m.build !== undefined) {
    if (typeof m.build !== "string" || !/^[a-f0-9]{64}$/.test(m.build)) throw new Error("Invalid remote build identity");
    out.build = m.build;
  }
  if (m.root !== undefined) {
    if (typeof m.root !== "string" || /[\r\n\0]/.test(m.root) || !(out.platform === "win32" ? win32 : posix).isAbsolute(m.root)) throw new Error("Invalid remote installation root");
    out.root = m.root;
  }
  if (m.daemonPid !== undefined) {
    if (!Number.isSafeInteger(m.daemonPid) || Number(m.daemonPid) < 1) throw new Error("Invalid remote daemon PID");
    out.daemonPid = Number(m.daemonPid);
  }
  for (const key of ["version", "bootstrappedAt"] as const) if (typeof m[key] === "string") out[key] = m[key];
  if (m.lastSeen !== undefined) {
    if (typeof m.lastSeen !== "string" || !Number.isFinite(Date.parse(m.lastSeen))) throw new Error("Invalid machine last-seen time");
    out.lastSeen = m.lastSeen;
  }
  return out;
}
export class MachineStore {
  constructor(readonly home = rigwellHome()) {}
  list(): Machine[] {
    const path = join(this.home, "machines.json");
    if (!existsSync(path)) return [];
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid machines.json");
    return rows.map(machineDefinition);
  }
  get(name: string): Machine {
    const row = this.list().find((m) => m.name === name);
    if (!row) throw new Error(`Unknown machine: ${name}`);
    return row;
  }
  save(input: Machine, replace = false): Machine {
    const row = machineDefinition(input), rows = this.list();
    const i = rows.findIndex((m) => m.name === row.name);
    if (i >= 0 && !replace) throw new Error("Machine already exists");
    if (i >= 0) rows[i] = row; else rows.push(row);
    this.write(rows);
    return row;
  }
  remove(name: string) {
    const rows = this.list();
    if (!rows.some((m) => m.name === name)) throw new Error(`Unknown machine: ${name}`);
    this.write(rows.filter((m) => m.name !== name));
  }
  private write(rows: Machine[]) {
    mkdirSync(this.home, { recursive: true });
    const path = join(this.home, "machines.json"), tmp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path);
  }
}
