// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/*
  How to start a provider CLI, and what environment it may see.

  A `.js/.mjs/.cjs` path is run BY Node, with the script as its first argument;
  Windows cannot exec it directly. A relative path is resolved once, so the
  path that was found and the path that is executed are the same file.
  `.cmd`/`.bat` are deliberately not spawned (Node refuses without a shell);
  the finders look for the real binary beside the npm shim instead.
*/

import path from "node:path";

export type CliProvider = "claude" | "codex";

/** A path this process should hand to Node rather than to the OS. */
export function isNodeScript(bin: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(bin.trim());
}

/** A CLI path that means the same file from any working directory. */
export function resolveCliPath(bin: string): string {
  const trimmed = bin.trim();
  if (!trimmed || path.isAbsolute(trimmed)) return trimmed;
  if (!/[/\\]/.test(trimmed)) return trimmed;
  return path.resolve(trimmed);
}

export type SpawnPlan = { command: string; args: string[] };

/** What to spawn, and with which arguments, for a resolved CLI path. */
export function spawnPlan(bin: string, args: string[]): SpawnPlan {
  return isNodeScript(bin) ? { command: process.execPath, args: [bin, ...args] } : { command: bin, args };
}

/** Names a provider CLI genuinely needs. Windows variable names are case-insensitive. */
const ALLOWED = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "OS",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "LOGNAME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_CLI_PATH",
  "CLAUDE_CLI_PATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
];

/** The one provider credential a Claude child may see, and only a Claude one. */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
];

function filtered(env: NodeJS.ProcessEnv, extra: readonly string[]): NodeJS.ProcessEnv {
  const allow = new Set([...ALLOWED, ...extra].map((name) => name.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!allow.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return out;
}

/** Name a home directory for a Codex child when the parent has none. */
export function withCodexHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const appData = env.APPDATA?.trim();
  const windowsRoot = env.USERPROFILE?.trim() || (appData ? path.resolve(appData, "..", "..") : undefined);
  const userRoot = windowsRoot || env.HOME?.trim();
  return {
    ...env,
    ...(windowsRoot && !env.USERPROFILE ? { USERPROFILE: windowsRoot } : {}),
    ...(userRoot && !env.HOME ? { HOME: userRoot } : {}),
    ...(userRoot && !env.CODEX_HOME ? { CODEX_HOME: path.join(userRoot, ".codex") } : {}),
  };
}

/**
 * The environment for a sign-in child: the allow-list, plus the Claude
 * credentials for a Claude child, plus Codex's home defaults for a Codex one.
 * No database URL, no auth secret, no other provider key.
 */
export function childEnv(provider: CliProvider, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return provider === "claude"
    ? filtered(env, CLAUDE_CREDENTIAL_ENV)
    : withCodexHome(filtered(env, []));
}
