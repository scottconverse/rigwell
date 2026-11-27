// Copied from model-setup-kit 204ad42. Do not edit here; change the kit and copy again.
/*
  Where the Claude Code and Codex CLIs are, in the same search order the
  product this kit was extracted from uses. Nothing is executed here.
*/

import { existsSync, readdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

import { resolveCliPath, type CliProvider } from "./cli-spawn.ts";

export type CliLookup = { ok: true; bin: string } | { ok: false; error: string | null };

export type FindCliOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  exists?: (candidate: string) => boolean;
  /** `npm prefix -g`, when the caller already knows it. */
  npmGlobalPrefix?: string;
};

function joinFor(win: boolean, ...parts: string[]): string {
  return parts
    .filter((part) => part !== "")
    .map((part, index) => {
      const trimmed = index === 0 ? part.replace(/[/\\]+$/, "") : part.replace(/^[/\\]+|[/\\]+$/g, "");
      return trimmed;
    })
    .join(win ? "\\" : "/");
}

function pathDirs(env: NodeJS.ProcessEnv, win: boolean): string[] {
  const raw = env.PATH ?? "";
  return raw
    .split(win ? ";" : ":")
    .map((dir) => dir.trim())
    .filter(Boolean);
}

function appDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const appData = env.APPDATA?.trim();
  if (appData) return appData;
  const profile = env.USERPROFILE?.trim() || env.HOME?.trim();
  return profile ? path.join(profile, "AppData", "Roaming") : undefined;
}

const CLAUDE_PACKAGE = "node_modules/@anthropic-ai/claude-code/bin/claude";

/** Every Claude Code candidate, in order. Exported so a test can pin it. */
export function claudeCliCandidates(options: FindCliOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const win = platform === "win32";
  const exists = options.exists ?? existsSync;
  const home = env.HOME || env.USERPROFILE || options.homedir || osHomedir();
  const explicit = env.CLAUDE_CLI_PATH?.trim();
  if (explicit) return [explicit];

  const out: string[] = [];
  if (home) {
    if (win) out.push(joinFor(win, home, ".local/bin/claude.exe"));
    out.push(joinFor(win, home, ".local/bin/claude"));
  }
  const prefix = options.npmGlobalPrefix?.trim();
  if (prefix) {
    out.push(
      win
        ? joinFor(win, prefix, `node_modules/@anthropic-ai/claude-code/bin/claude.exe`)
        : joinFor(win, prefix, `lib/${CLAUDE_PACKAGE}`),
    );
  }
  const appData = appDataDir(env);
  if (appData) out.push(joinFor(win, appData, `npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`));
  for (const dir of pathDirs(env, win)) {
    out.push(joinFor(win, dir, win ? "claude.exe" : "claude"));
    if (win && exists(joinFor(win, dir, "claude.cmd"))) {
      out.push(joinFor(win, dir, `node_modules/@anthropic-ai/claude-code/bin/claude.exe`));
    }
  }
  if (home) out.push(joinFor(win, home, `.npm-global/lib/${CLAUDE_PACKAGE}`));
  out.push(joinFor(win, "/usr/local", `lib/${CLAUDE_PACKAGE}`));
  out.push(joinFor(win, "/usr", `lib/${CLAUDE_PACKAGE}`));
  return out;
}

/** Binary under every scoop Node install, on Windows only. */
function scoopNodeCliCandidates(env: NodeJS.ProcessEnv, home: string | undefined): string[] {
  if (!home) return [];
  const persist = path.join(home, "scoop", "persist");
  let names: string[];
  try {
    names = readdirSync(persist);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.toLowerCase().startsWith("nodejs"))
    .sort()
    .map((name) =>
      path.join(
        persist,
        name,
        "bin",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      ),
    );
}

export function codexCliPathMissing(named: string): string {
  return (
    `CODEX_CLI_PATH is set to ${named}, but there is no file there. ` +
    `Correct the path, or unset CODEX_CLI_PATH to let this app find Codex itself.`
  );
}

function codexLookup(options: FindCliOptions): CliLookup {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const named = env.CODEX_CLI_PATH?.trim();
  if (named) {
    if (exists(named)) return { ok: true, bin: resolveCliPath(named) };
    return { ok: false, error: codexCliPathMissing(named) };
  }
  const appData = appDataDir(env);
  if (appData) {
    const vendor = path.join(
      appData,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    if (exists(vendor)) return { ok: true, bin: vendor };
    const shim = path.join(appData, "npm", (options.platform ?? process.platform) === "win32" ? "codex.cmd" : "codex");
    if (exists(shim)) return { ok: true, bin: shim };
  }
  // A bare name: a PATH lookup that has not been confirmed. Callers treat it
  // as "nothing to spawn here until a probe agrees".
  return { ok: true, bin: "codex" };
}

/** The first Claude Code candidate that exists, or null. */
export function findClaudeCli(options: FindCliOptions = {}): string | null {
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || options.homedir;
  const explicit = Boolean(env.CLAUDE_CLI_PATH?.trim());
  const candidates = explicit
    ? claudeCliCandidates(options)
    : [...claudeCliCandidates(options), ...scoopNodeCliCandidates(env, home)];
  for (const candidate of candidates) {
    // Only a path the caller wrote by hand is resolved; a PATH candidate is
    // already the exact file that was found.
    if (exists(candidate)) return explicit ? resolveCliPath(candidate) : candidate;
  }
  return null;
}

export function findCodexCli(options: FindCliOptions = {}): CliLookup {
  return codexLookup(options);
}

/** One entry point for both providers. A Claude miss is `ok:false` with no error. */
export function findCli(provider: CliProvider, options: FindCliOptions = {}): CliLookup {
  if (provider === "claude") {
    const bin = findClaudeCli(options);
    return bin ? { ok: true, bin } : { ok: false, error: null };
  }
  return findCodexCli(options);
}
