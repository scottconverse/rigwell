// Copied from model-setup-kit d40de0a. Do not edit here; change the kit and copy again.
/*
  Ollama: is it running, and the optional "ollama signin" flow.

  The sign-in runs that command, reads the link it prints, and hands only the
  link back. It never asks for, stores or logs a credential; the CLI owns its
  own file. A build without the command is reported in plain words.

  `ollama signin` without a terminal is not verified. The implementation treats
  "a URL appeared on stdout or stderr" as the link, and a clean exit (code 0)
  as "signed in".
*/

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { defaultFetch, trimSlash, withTimeout, type FetchLike } from "./util.ts";
import type { SpawnedChild, SpawnFn } from "./cli-signin.ts";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export type OllamaStatusResult = {
  running: boolean;
  version?: string;
  baseUrl: string;
};

const STATUS_TIMEOUT_MS = 1_500;

/** Ask `/api/version`, then `/api/tags`. Never throws. */
export async function ollamaStatus(
  options: { baseUrl?: string; fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<OllamaStatusResult> {
  const baseUrl = trimSlash(options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  const fetchFn = options.fetchFn ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  try {
    const res = await withTimeout(
      fetchFn(`${baseUrl}/api/version`, { headers: { Accept: "application/json" } }),
      timeoutMs,
    );
    if (res.ok) {
      let version: string | undefined;
      try {
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version === "string" && body.version.trim()) version = body.version.trim();
      } catch {
        /* answered, but no readable version */
      }
      return { running: true, baseUrl, ...(version ? { version } : {}) };
    }
  } catch {
    /* try the second endpoint below */
  }
  try {
    const res = await withTimeout(
      fetchFn(`${baseUrl}/api/tags`, { headers: { Accept: "application/json" } }),
      timeoutMs,
    );
    if (res.ok) return { running: true, baseUrl };
  } catch {
    /* not running */
  }
  return { running: false, baseUrl };
}

export type OllamaExecutableOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
};

/** Find the `ollama` program without running it: PATH, then the Windows install folder. */
export function resolveOllamaExecutable(options: OllamaExecutableOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const names = platform === "win32" ? ["ollama.exe", "ollama.cmd", "ollama"] : ["ollama"];
  const dirs = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const localAppData = env.LOCALAPPDATA?.trim();
  if (platform === "win32" && localAppData) {
    dirs.push(path.join(localAppData, "Programs", "Ollama"));
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export type OllamaSignInStatus =
  | "starting"
  | "awaiting_user"
  | "done"
  | "failed"
  | "no-signin"
  | "not-installed"
  | "cancelled";

export type OllamaSignInState = {
  status: OllamaSignInStatus;
  url: string | null;
  detail: string;
  pid: number | null;
};

export const OLLAMA_SIGNIN_START_FAILED = "Ollama did not start the sign-in. You can skip this step.";
export const OLLAMA_SIGNIN_NO_LINK = "Ollama did not print a sign-in link. You can skip this step.";
export const OLLAMA_SIGNIN_NOT_INSTALLED = "Ollama is not installed on this machine. You can skip this step.";
export const OLLAMA_SIGNIN_NOT_SIGNED_IN = "Ollama did not finish the sign-in. You can skip this step.";
export const OLLAMA_NO_SIGNIN_WORDS = "This Ollama version has no sign-in. You can skip this step.";
export const OLLAMA_SIGNED_IN_WORDS = "Signed in";
export const OLLAMA_SIGN_IN_LINK_LINE = "Open this link to sign in to ollama.com. You can skip this step.";

const URL_RE = /https?:\/\/[^\s"'<>]+/;
const DEFAULT_LINK_WAIT_MS = 15_000;
const NO_SIGNIN_RE = /unknown\s+(?:command|flag|subcommand)|unrecognized|not a valid command|no such command/i;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as SpawnedChild;

type Active = {
  child: SpawnedChild;
  status: OllamaSignInStatus;
  url: string | null;
  detail: string;
  exited: boolean;
  output: string;
};

export type OllamaSignInOptions = OllamaExecutableOptions & {
  spawnFn?: SpawnFn;
  linkWaitMs?: number;
};

export class OllamaSignIn {
  private readonly spawnFn: SpawnFn;
  private readonly linkWaitMs: number;
  private readonly executableOptions: OllamaExecutableOptions;
  private active: Active | null = null;

  constructor(options: OllamaSignInOptions = {}) {
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.linkWaitMs = options.linkWaitMs ?? DEFAULT_LINK_WAIT_MS;
    this.executableOptions = { env: options.env, platform: options.platform, exists: options.exists };
  }

  private snapshot(row: Active): OllamaSignInState {
    return {
      status: row.status,
      url: row.url,
      detail: row.detail,
      pid: row.child.pid ?? null,
    };
  }

  /** Run `ollama signin` and wait briefly for the link it prints. */
  async start(): Promise<OllamaSignInState> {
    if (this.active && !this.active.exited) return this.snapshot(this.active);

    const executable = resolveOllamaExecutable(this.executableOptions);
    if (!executable) {
      return { status: "not-installed", url: null, detail: OLLAMA_SIGNIN_NOT_INSTALLED, pid: null };
    }

    let child: SpawnedChild;
    try {
      child = this.spawnFn(executable, ["signin"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return { status: "failed", url: null, detail: OLLAMA_SIGNIN_START_FAILED, pid: null };
    }

    const row: Active = {
      child,
      status: "starting",
      url: null,
      detail: "Waiting for Ollama to print its link…",
      exited: false,
      output: "",
    };
    this.active = row;

    /** Resolves the wait below as soon as the link, an error or an exit lands. */
    const wait: { done: (() => void) | null } = { done: null };
    const notify = () => wait.done?.();

    const read = (chunk: unknown) => {
      row.output = (row.output + String(chunk)).slice(-8_000);
      if (!row.url) {
        const match = URL_RE.exec(row.output);
        if (match) {
          row.url = match[0];
          row.status = "awaiting_user";
          row.detail = "";
          notify();
        }
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", () => {
      row.exited = true;
      row.status = "failed";
      row.detail = OLLAMA_SIGNIN_START_FAILED;
      notify();
    });
    child.on("exit", (code) => {
      row.exited = true;
      if (code === 0) {
        row.status = "done";
        row.detail = "";
      } else if (NO_SIGNIN_RE.test(row.output)) {
        row.status = "no-signin";
        row.detail = OLLAMA_NO_SIGNIN_WORDS;
      } else if (row.url) {
        row.status = "failed";
        row.detail = OLLAMA_SIGNIN_NOT_SIGNED_IN;
      } else {
        row.status = "failed";
        row.detail = OLLAMA_SIGNIN_NO_LINK;
      }
      notify();
    });

    // Wait for the link, the process exit, or the ceiling -- whichever is first.
    await new Promise<void>((resolve) => {
      if (row.url || row.exited) return resolve();
      const timer = setTimeout(resolve, this.linkWaitMs);
      void timer;
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      wait.done = done;
      child.on("exit", done);
      const poll = setInterval(() => {
        if (row.url || row.exited) {
          clearInterval(poll);
          done();
        }
      }, 100);
      (poll as unknown as { unref?: () => void }).unref?.();
      const stop = setTimeout(() => clearInterval(poll), this.linkWaitMs + 250);
      (stop as { unref?: () => void }).unref?.();
    });

    if (!row.url && !row.exited) {
      row.status = "failed";
      row.detail = OLLAMA_SIGNIN_NO_LINK;
    }
    return this.snapshot(row);
  }

  poll(): OllamaSignInState | null {
    return this.active ? this.snapshot(this.active) : null;
  }

  /** Stop the sign-in attempt this instance started. */
  cancel(): OllamaSignInState | null {
    if (!this.active) return null;
    try {
      this.active.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.active.exited = true;
    this.active.status = "cancelled";
    this.active.detail = "";
    return this.snapshot(this.active);
  }
}
