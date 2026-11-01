// Sandbox policy (spec 5.5.8): settings shape, org merge (stricter wins), effective policy, domain/path matching.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SandboxMode = "per-command" | "whole-process";

export interface SandboxFilesystemSettings {
  allowWrite?: string[];
  allowRead?: string[];
  denyWrite?: string[];
  denyRead?: string[];
}

export interface SandboxNetworkSettings {
  allowedDomains?: string[];
  /** Never "*". */
  deniedDomains?: string[];
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
}

export interface SandboxSettings {
  enabled?: boolean;
  mode?: SandboxMode;
  filesystem?: SandboxFilesystemSettings;
  network?: SandboxNetworkSettings;
}

export type NetworkRule = "none" | "all" | "proxy";

export interface SandboxPolicy {
  /** Absolute, symlink-resolved where the path exists. */
  writable: string[];
  /** Mounted read-only on top of a writable parent. */
  readOnly: string[];
  /** Hidden from the command (directories become empty, files read as empty). */
  unreadable: string[];
  /** Re-exposed inside an unreadable directory. */
  readAllowed: string[];
  network: {
    rule: NetworkRule;
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    httpProxyPort?: number;
  };
  /** Org rules that a user "allow always" cannot override (shown as a warning in the prompt). */
  orgRules: { denyRead: string[]; denyWrite: string[]; deniedDomains: string[] };
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function contains(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Does `host` match a rule: exact name, `*.example.com` for any subdomain, or `*` for everything. */
export function domainMatches(rule: string, host: string): boolean {
  const r = rule.trim().toLowerCase();
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (r === "*") return true;
  if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
  return r === h;
}

export function domainAllowed(host: string, allowed: string[], denied: string[]): { ok: true } | { ok: false; reason: "deny-list" | "not-allowed" } {
  if (denied.some((d) => domainMatches(d, host))) return { ok: false, reason: "deny-list" };
  if (allowed.some((a) => domainMatches(a, host))) return { ok: true };
  return { ok: false, reason: "not-allowed" };
}

function intersectPaths(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out: string[] = [];
  for (const x of a) if (b.some((y) => contains(y, x))) out.push(x);
  for (const y of b) if (a.some((x) => contains(x, y))) out.push(y);
  return uniq(out);
}

function intersectDomains(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a.includes("*")) return b;
  if (b.includes("*")) return a;
  const probe = (r: string) => r.replace(/^\*\./, "x.");
  const out: string[] = [];
  for (const x of a) if (b.some((y) => domainMatches(y, probe(x)))) out.push(x);
  for (const y of b) if (a.some((x) => domainMatches(x, probe(y)))) out.push(y);
  return uniq(out);
}

const union = (a?: string[], b?: string[]): string[] | undefined => (a || b ? uniq([...(a ?? []), ...(b ?? [])]) : undefined);

/** Org merge (spec 5.5.8): the stricter setting wins. Enabled if either enables; whole-process beats
 * per-command; allow lists are intersected; deny lists are unioned. Pure. */
export function mergeSandboxOrg(org: SandboxSettings | undefined, user: SandboxSettings | undefined): SandboxSettings {
  if (!org) return user ?? {};
  if (!user) return org;
  const out: SandboxSettings = {};
  out.enabled = !!(org.enabled || user.enabled);
  const mode = org.mode === "whole-process" || user.mode === "whole-process" ? "whole-process" : (org.mode ?? user.mode);
  if (mode) out.mode = mode;
  const f: SandboxFilesystemSettings = {};
  const aw = intersectPaths(org.filesystem?.allowWrite, user.filesystem?.allowWrite);
  const ar = intersectPaths(org.filesystem?.allowRead, user.filesystem?.allowRead);
  const dw = union(org.filesystem?.denyWrite, user.filesystem?.denyWrite);
  const dr = union(org.filesystem?.denyRead, user.filesystem?.denyRead);
  if (aw) f.allowWrite = aw;
  if (ar) f.allowRead = ar;
  if (dw) f.denyWrite = dw;
  if (dr) f.denyRead = dr;
  if (Object.keys(f).length) out.filesystem = f;
  const n: SandboxNetworkSettings = {};
  const ad = intersectDomains(org.network?.allowedDomains, user.network?.allowedDomains);
  const dd = union(org.network?.deniedDomains, user.network?.deniedDomains);
  if (ad) n.allowedDomains = ad;
  if (dd) n.deniedDomains = dd;
  // Permissive switches survive only when every side that sets them allows them.
  const both = (k: "allowAllUnixSockets" | "allowLocalBinding") => {
    const vals = [org.network?.[k], user.network?.[k]].filter((v) => v !== undefined);
    return vals.length ? vals.every(Boolean) : undefined;
  };
  const aus = both("allowAllUnixSockets");
  const alb = both("allowLocalBinding");
  if (aus !== undefined) n.allowAllUnixSockets = aus;
  if (alb !== undefined) n.allowLocalBinding = alb;
  const aun = intersectPaths(org.network?.allowUnixSockets, user.network?.allowUnixSockets);
  if (aun) n.allowUnixSockets = aun;
  const port = user.network?.httpProxyPort ?? org.network?.httpProxyPort;
  if (port !== undefined) n.httpProxyPort = port;
  if (Object.keys(n).length) out.network = n;
  return out;
}

/** Credential files that are never readable or writable from a sandboxed command. */
export function credentialPaths(home: string, rigwellHome: string): string[] {
  return [
    ".ssh", ".aws", ".gnupg", ".netrc", ".git-credentials", ".config/gh", ".config/gcloud", ".kube",
    ".docker/config.json", ".npmrc", ".pypirc",
  ].map((p) => path.join(home, p)).concat(
    ["credentials.json", "auth.json", ".credentials.json", "keys.json", "secrets.json"].map((f) => path.join(rigwellHome, f)),
  );
}

/** Paths no allow can ever open: credential files, org policy cache, certs, agent bin/tools folders. */
export function protectedPaths(home: string, rigwellHome: string): string[] {
  return [
    ...credentialPaths(home, rigwellHome),
    path.join(rigwellHome, "org-managed-settings.cache.json"),
    path.join(rigwellHome, "org-managed-settings.cache.json.backup"),
    path.join(rigwellHome, "certs"), path.join(rigwellHome, "bin"), path.join(rigwellHome, "tools"),
  ].map(realOrSelf);
}

export interface SessionGrants {
  allowWrite: string[];
  allowRead: string[];
  allowedDomains: string[];
}

export interface PolicyInput {
  cwd: string;
  home: string;
  rigwellHome: string;
  settings: SandboxSettings | undefined;
  /** Org-managed sandbox settings; merged with `settings` (stricter wins). */
  org?: SandboxSettings;
  /** Granted for this session only ("allow once"). */
  session?: SessionGrants;
  /** Hosts the agent itself needs (model API hosts). */
  vendorHosts?: string[];
  /** Whether the host can bridge the network to a filtering proxy. */
  canProxy: boolean;
}

/** Builds the effective policy. Pure apart from resolving symlinks. */
export function buildPolicy(i: PolicyInput): SandboxPolicy {
  const merged = mergeSandboxOrg(i.org, i.settings);
  const resolve = (p: string) => realOrSelf(path.resolve(i.cwd, expandHome(p, i.home)));
  const cwd = realOrSelf(i.cwd);
  const rhome = realOrSelf(i.rigwellHome);
  const creds = credentialPaths(i.home, rhome).map(realOrSelf);

  const writable = uniq([cwd, rhome, ...(merged.filesystem?.allowWrite ?? []).map(resolve), ...(i.session?.allowWrite ?? []).map(resolve)]);
  const readOnly = uniq([
    ...protectedPaths(i.home, rhome),
    ...(merged.filesystem?.denyWrite ?? []).map(resolve),
  ]);
  const allowRead = uniq([...(merged.filesystem?.allowRead ?? []), ...(i.session?.allowRead ?? [])].map(resolve));
  const unreadable = uniq([...creds, ...(merged.filesystem?.denyRead ?? []).map(resolve)]);
  // Credential files stay unreadable even if allowRead names them.
  const readAllowed = allowRead.filter((p) => !creds.some((c) => contains(c, p) || contains(p, c)));

  const allowed = uniq([...(merged.network?.allowedDomains ?? []), ...(i.session?.allowedDomains ?? []), ...(i.vendorHosts ?? [])]);
  const denied = (merged.network?.deniedDomains ?? []).filter((d) => d !== "*");
  let rule: NetworkRule;
  if (allowed.includes("*") && denied.length === 0) rule = "all";
  else if (allowed.length === 0) rule = "none";
  else rule = i.canProxy ? "proxy" : "none";
  return {
    writable, readOnly, unreadable, readAllowed,
    network: {
      rule, allowedDomains: allowed, deniedDomains: denied,
      allowLocalBinding: merged.network?.allowLocalBinding === true,
      ...(merged.network?.httpProxyPort !== undefined ? { httpProxyPort: merged.network.httpProxyPort } : {}),
    },
    orgRules: {
      denyRead: (i.org?.filesystem?.denyRead ?? []).map(resolve),
      denyWrite: (i.org?.filesystem?.denyWrite ?? []).map(resolve),
      deniedDomains: i.org?.network?.deniedDomains ?? [],
    },
  };
}

export function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
