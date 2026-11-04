import { chmodSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Owner-only files (spec: credential file, secrets index, daemon.json, setup-script env files).
 * POSIX: mode 0600 for files, 0700 for folders.
 * Windows has no mode bits (chmod only toggles read-only), so the equivalent is an NTFS ACL: inheritance is removed
 * and only the current user is granted access (`icacls <path> /inheritance:r /grant:r <user>:F`). Best effort:
 * if icacls is missing or fails the file stays as created (it lives under the user's profile, which other
 * non-admin users cannot read by default) and the function returns false.
 */
export function makePrivate(target: string, opts: { dir?: boolean; platform?: NodeJS.Platform; user?: string } = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    try { chmodSync(target, opts.dir ? 0o700 : 0o600); return true; } catch { return false; }
  }
  const user = opts.user ?? process.env.USERNAME;
  if (!user) return false;
  const domain = process.env.USERDOMAIN;
  const who = domain ? `${domain}\\${user}` : user;
  const grant = opts.dir ? `${who}:(OI)(CI)F` : `${who}:F`;
  try {
    const r = spawnSync("icacls", [target, "/inheritance:r", "/grant:r", grant], { stdio: "ignore", windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Names that mean "other users can reach this file" in `icacls` output. */
const BROAD = /(?:^|[\s\\])(Everyone|Users|Authenticated Users|BUILTIN\\Users|Domain Users)(?::|\s)/i;

/** True when an `icacls` listing shows no entry for broad groups. Pure, so it can be tested anywhere. */
export function aclIsOwnerOnly(icaclsOutput: string): boolean {
  for (const line of icaclsOutput.split(/\r?\n/)) {
    if (/Successfully processed/i.test(line)) continue;
    if (BROAD.test(line)) return false;
  }
  return true;
}

/** What is enforced for a file: the permission bits on POSIX, the ACL on Windows (undefined if it cannot be read). */
export function isPrivate(target: string, platform: NodeJS.Platform = process.platform): boolean | undefined {
  if (platform !== "win32") {
    try { return (statSync(target).mode & 0o077) === 0; } catch { return undefined; }
  }
  try {
    const r = spawnSync("icacls", [target], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return undefined;
    return aclIsOwnerOnly(String(r.stdout));
  } catch {
    return undefined;
  }
}
