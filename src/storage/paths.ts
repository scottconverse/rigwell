// Filesystem layout helpers (spec §12.1). Home folder: $RIGWELL_HOME or ~/.rigwell.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** The user's real home directory ($HOME / $USERPROFILE honoured so tests can override). */
export function userHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function rigwellHome(): string {
  const o = process.env.RIGWELL_HOME;
  if (o && o.length > 0) return path.resolve(o);
  return path.join(userHomeDir(), ".rigwell");
}

export function sessionsDir(): string {
  return path.join(rigwellHome(), "sessions");
}

const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const WIN_DRIVE_ONLY = /^[A-Za-z]:$/;

/**
 * Slug of a working directory (spec §12.1, 7 steps):
 * ~ expand, absolute, realpath if exists, strip trailing slashes, drop ':' after a drive
 * letter, runs of / or \ -> '-', leading '-'.
 * `/home/a/b` -> `-home-a-b` (the leading '/' already became '-'), `C:\Users\scott` -> `-C-Users-scott`.
 * Windows-style paths are processed textually on any platform (no resolve/realpath).
 */
export function projectSlug(cwd: string): string {
  let p = cwd;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = userHomeDir() + p.slice(1);
  if (!WIN_ABS.test(p) && !WIN_DRIVE_ONLY.test(p)) {
    p = path.resolve(p);
    try {
      if (existsSync(p)) p = realpathSync(p);
    } catch {
      /* keep unresolved */
    }
  }
  p = p.replace(/[\\/]+$/, "");
  p = p.replace(/^([A-Za-z]):/, "$1");
  p = p.replace(/[\\/]+/g, "-");
  if (!p.startsWith("-")) p = "-" + p;
  return p;
}

export function projectSessionsDir(cwd: string): string {
  return path.join(sessionsDir(), projectSlug(cwd));
}

export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("..") &&
    !id.includes("\0")
  );
}

/** Throws on an empty id or one containing `/`, `\`, `..` or NUL. Returns the id. */
export function validateSessionId(id: string): string {
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  return id;
}

export interface HostInfo {
  schemaVersion: 1;
  hostId: string;
  createdAt: number;
}

/** Reads (or creates) `$RIGWELL_HOME/host.json` and returns the host id. */
export function hostId(): string {
  const file = path.join(rigwellHome(), "host.json");
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (j && typeof j.hostId === "string" && j.hostId) return j.hostId;
  } catch {
    /* create below */
  }
  mkdirSync(rigwellHome(), { recursive: true });
  const info: HostInfo = { schemaVersion: 1, hostId: randomUUID(), createdAt: Date.now() };
  writeFileSync(file, JSON.stringify(info, null, 2) + "\n");
  return info.hostId;
}
