// Copied from model-setup-kit 204ad42. Do not edit here; change the kit and copy again.
/*
  Sign in to the Claude Code and Codex CLIs from inside a host app.

  The CLIs own their credential files; this module never reads, stores or logs
  a credential. What crosses the boundary is a URL, a one-time code the human
  is meant to read, and an exit status. `detail` is redacted before it is kept.

  Success is never "the CLI exited": it is "a probe says signed in afterwards".
  The probe is host-given; the default copies the product this kit came from
  (`claude auth status --json` with loggedIn true and exit 0; `codex login
  status` with exit 0).

  All time, spawning and probing go through injectable parts so tests use fakes.
*/

import { spawn } from "node:child_process";

import { childEnv, loginChildEnv, spawnPlan, type CliProvider } from "./cli-spawn.ts";
import { findCli, type CliLookup } from "./cli-find.ts";

export type { CliProvider };

export type CliAttemptStatus =
  | "starting"
  | "awaiting_user"
  | "done"
  | "failed"
  | "expired"
  | "cancelled";

export type CliAttempt = {
  id: number;
  provider: CliProvider;
  status: CliAttemptStatus;
  url: string | null;
  code: string | null;
  detail: string;
  /** Milliseconds since the epoch, from the injected clock. */
  startedAt: number;
  expiresInSeconds: number;
};

export type CliProbeResult = { signedIn: boolean; account?: string; detail?: string };

export type CliStatusEntry = {
  provider: CliProvider;
  name: string;
  installed: boolean;
  signedIn: boolean;
  account: string | null;
  path: string | null;
  detail: string;
};

export const PROVIDER_LABEL: Record<CliProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** How long an attempt may sit unanswered. */
export const DEFAULT_LOGIN_LIMIT_MS: Record<CliProvider, number> = {
  claude: 10 * 60_000,
  codex: 15 * 60_000,
};

const OPEN: CliAttemptStatus[] = ["starting", "awaiting_user"];

/** Keep only the tail of a stream: enough for the last line, never unbounded. */
const MAX_OUTPUT_BYTES = 64 * 1024;

const appendTail = (current: string, chunk: unknown): string =>
  (current + String(chunk)).slice(-MAX_OUTPUT_BYTES);

/* ── Spawned children ──────────────────────────────────────────────────── */

type Listener = (...args: unknown[]) => void;

export type SpawnedChild = {
  pid?: number;
  stdout?: { on(event: string, listener: Listener): unknown } | null;
  stderr?: { on(event: string, listener: Listener): unknown } | null;
  on(event: string, listener: Listener): unknown;
  kill(signal?: string): boolean;
  unref?(): void;
};

export type SpawnFn = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => SpawnedChild;

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as SpawnedChild;

/* ── Parsing what the CLIs print ───────────────────────────────────────── */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The first https URL in the output, with trailing punctuation trimmed. */
export function firstHttpsUrl(text: string): string | null {
  const match = stripAnsi(text).match(/https:\/\/[^\s"'<>`]+/);
  if (!match) return null;
  return match[0].replace(/[.,;:)\]]+$/, "");
}

/** `claude auth login --claudeai` prints one URL and then waits. */
export function parseClaudeLogin(text: string): { url: string | null } {
  return { url: firstHttpsUrl(text) };
}

/**
 * `codex login --device-auth` prints a URL and, later, the code. The code is
 * read positionally (the next non-blank line after the announcement); the
 * shape regex is only a fallback for a layout change.
 */
export function parseCodexLogin(text: string): { url: string | null; code: string | null } {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const url = firstHttpsUrl(clean);
  let code: string | null = null;
  const announced = lines.findIndex((line) => /one-time code/i.test(line));
  if (announced >= 0) {
    for (const line of lines.slice(announced + 1)) {
      const trimmed = line.trim();
      if (trimmed) {
        code = trimmed;
        break;
      }
    }
  }
  if (!code) {
    const shaped = clean.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/);
    code = shaped ? shaped[0] : null;
  }
  return { url, code };
}

/** Take anything that could be a secret out of a line before it is kept. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/g, "[redacted]")
    .replace(/(token|secret|password|credential)\s*[:=]\s*\S+/gi, "$1: [redacted]");
}

/** Last non-empty line of a stream, redacted and clipped. */
export function lastLine(text: string, max = 200): string {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return redactSecrets(lines[lines.length - 1] ?? "").slice(0, max);
}

/* ── The sign-in runner ────────────────────────────────────────────────── */

export type CliSignInOptions = {
  probe?: (provider: CliProvider) => Promise<CliProbeResult>;
  spawnFn?: SpawnFn;
  now?: () => number;
  limitsMs?: Partial<Record<CliProvider, number>>;
  appName?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  exists?: (candidate: string) => boolean;
  /** Re-probe at most this often while polling. Default 3 s. */
  pollIntervalMs?: number;
  /** Ceiling for a probe command. Default 10 s. */
  probeTimeoutMs?: number;
  /**
   * How to find the binary a sign-in spawns. A host whose probe uses its own
   * finder passes it here so the probe and the spawn agree on one program.
   */
  findBinary?: (provider: CliProvider) => CliLookup;
};

type Live = { child: SpawnedChild; timer: ReturnType<typeof setTimeout> };

type AttemptRecord = Omit<CliAttempt, "expiresInSeconds">;

export class CliSignIn {
  private readonly probeFn: (provider: CliProvider) => Promise<CliProbeResult>;
  private readonly spawnFn: SpawnFn;
  private readonly clock: () => number;
  private readonly limits: Record<CliProvider, number>;
  private readonly appName: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: string | undefined;
  private readonly exists: ((candidate: string) => boolean) | undefined;
  private readonly pollIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly findBinaryOverride: ((provider: CliProvider) => CliLookup) | undefined;

  private nextId = 1;
  private readonly attempts = new Map<number, AttemptRecord>();
  private readonly live = new Map<number, Live>();
  private readonly lastPoll = new Map<number, number>();

  constructor(options: CliSignInOptions = {}) {
    this.probeFn = options.probe ?? ((provider) => this.defaultProbe(provider));
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.clock = options.now ?? Date.now;
    this.limits = { ...DEFAULT_LOGIN_LIMIT_MS, ...(options.limitsMs ?? {}) };
    this.appName = options.appName?.trim() || "this app";
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homedir = options.homedir;
    this.exists = options.exists;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
    this.findBinaryOverride = options.findBinary;
  }

  private lookup(provider: CliProvider): CliLookup {
    return findCli(provider, {
      env: this.env,
      platform: this.platform,
      homedir: this.homedir,
      exists: this.exists,
    });
  }

  /** The binary a sign-in may spawn, or why there is nothing to spawn. */
  private findBinary(provider: CliProvider): { ok: true; bin: string } | { ok: false; error: string | null } {
    const found = this.findBinaryOverride ? this.findBinaryOverride(provider) : this.lookup(provider);
    if (!found.ok) return { ok: false, error: found.error };
    if (provider === "codex" && found.bin === "codex") {
      // A bare PATH name is probed for status, but is not a path to spawn.
      return { ok: false, error: null };
    }
    return { ok: true, bin: found.bin };
  }

  private view(record: AttemptRecord): CliAttempt {
    const limit = this.limits[record.provider];
    const elapsed = this.clock() - record.startedAt;
    const left = limit - elapsed;
    return {
      ...record,
      expiresInSeconds: OPEN.includes(record.status) ? Math.max(0, Math.round(left / 1000)) : 0,
    };
  }

  private openAttempt(provider: CliProvider): AttemptRecord | undefined {
    for (const record of this.attempts.values()) {
      if (record.provider === provider && OPEN.includes(record.status) && this.view(record).expiresInSeconds > 0) {
        return record;
      }
    }
    return undefined;
  }

  private forget(id: number): void {
    const entry = this.live.get(id);
    if (entry) clearTimeout(entry.timer);
    this.live.delete(id);
  }

  /**
   * End a spawned CLI and everything it started. Cancel, expire and poll only
   * ever kill a child this instance still holds.
   */
  private killTree(pid: number | undefined, child: SpawnedChild): void {
    if (pid && this.platform === "win32") {
      try {
        const killer = this.spawnFn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        });
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private loginArgs(provider: CliProvider): string[] {
    return provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"];
  }

  private expire(id: number): void {
    const entry = this.live.get(id);
    this.forget(id);
    if (entry) this.killTree(entry.child.pid, entry.child);
    const record = this.attempts.get(id);
    if (!record) return;
    record.status = "expired";
    record.detail = "That link ran out of time before anyone finished the sign-in.";
  }

  /**
   * Start a sign-in, or hand back the one already waiting. Two Codex device
   * flows at once would print two codes and only one of them works.
   */
  async start(provider: CliProvider): Promise<CliAttempt> {
    const existing = this.openAttempt(provider);
    if (existing) return this.view(existing);

    const record: AttemptRecord = {
      id: this.nextId++,
      provider,
      status: "starting",
      url: null,
      code: null,
      detail: "",
      startedAt: this.clock(),
    };
    this.attempts.set(record.id, record);

    const found = this.findBinary(provider);
    if (!found.ok) {
      record.status = "failed";
      record.detail = found.error ?? `${PROVIDER_LABEL[provider]} is not installed on this machine.`;
      return this.view(record);
    }

    let child: SpawnedChild;
    try {
      const plan = spawnPlan(found.bin, this.loginArgs(provider));
      child = this.spawnFn(plan.command, plan.args, {
        // Detached with stdin closed is the whole trick: the CLI sees no TTY,
        // gives up on prompting, and prints the URL it would print to a browser.
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: loginChildEnv(provider, this.env),
      });
    } catch {
      record.status = "failed";
      record.detail = "That command would not start.";
      return this.view(record);
    }

    let stdout = "";
    let stderr = "";
    const consider = () => {
      if (record.status !== "starting") return;
      const text = `${stdout}\n${stderr}`;
      const parsed =
        provider === "codex" ? parseCodexLogin(text) : { ...parseClaudeLogin(text), code: null };
      if (!parsed.url) return;
      if (provider === "codex" && !parsed.code) return;
      record.status = "awaiting_user";
      record.url = parsed.url;
      record.code = parsed.code;
      record.detail = "";
    };

    child.stdout?.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
      consider();
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
      consider();
    });

    child.on("error", () => {
      this.forget(record.id);
      record.status = "failed";
      record.detail = "That command would not start.";
    });

    child.on("close", (code) => {
      this.forget(record.id);
      void (async () => {
        let probed: CliProbeResult;
        try {
          probed = await this.probeFn(provider);
        } catch (error) {
          if (record.status !== "starting" && record.status !== "awaiting_user") return;
          record.status = "failed";
          record.detail = redactSecrets(
            error instanceof Error && error.message
              ? error.message
              : "The sign-in check could not run.",
          );
          return;
        }
        if (probed.signedIn) {
          if (record.status === "starting" || record.status === "awaiting_user") {
            record.status = "done";
            record.detail = "";
          }
          return;
        }
        // Cancel and expiry already wrote their own verdict.
        if (record.status !== "starting" && record.status !== "awaiting_user") return;
        const said = lastLine(stderr) || lastLine(stdout);
        record.status = "failed";
        record.detail = redactSecrets(
          said || `That sign-in ended without completing (exit ${String(code)}).`,
        );
      })();
    });

    const timer = setTimeout(() => this.expire(record.id), this.limits[provider]);
    (timer as { unref?: () => void }).unref?.();
    this.live.set(record.id, { child, timer });
    child.unref?.();

    return this.view(record);
  }

  /**
   * Where an open attempt stands right now. A login can complete without the
   * spawned CLI exiting, so an open attempt is re-probed at most once per
   * interval; a passing probe kills the child and marks the attempt done.
   */
  async poll(id: number): Promise<CliAttempt | null> {
    const record = this.attempts.get(id);
    if (!record) return null;
    if (!OPEN.includes(record.status)) return this.view(record);
    if (this.view(record).expiresInSeconds <= 0) {
      this.expire(id);
      return this.view(record);
    }
    const now = this.clock();
    if (now - (this.lastPoll.get(id) ?? 0) < this.pollIntervalMs) return this.view(record);
    this.lastPoll.set(id, now);
    const probed = await this.probeFn(record.provider);
    if (!probed.signedIn) return this.view(record);
    if (record.status !== "starting" && record.status !== "awaiting_user") return this.view(record);
    const entry = this.live.get(id);
    this.forget(id);
    if (entry) this.killTree(entry.child.pid, entry.child);
    record.status = "done";
    record.detail = "";
    return this.view(record);
  }

  /** Stop an attempt and kill only the child this instance started. */
  async cancel(id: number): Promise<CliAttempt | null> {
    const record = this.attempts.get(id);
    if (!record) return null;
    if (!OPEN.includes(record.status)) return this.view(record);
    const entry = this.live.get(id);
    this.forget(id);
    if (entry) this.killTree(entry.child.pid, entry.child);
    record.status = "cancelled";
    record.detail = `Stopped by ${this.appName}.`;
    return this.view(record);
  }

  /** Installed, signed in, account and path for both providers. */
  async status(): Promise<CliStatusEntry[]> {
    const out: CliStatusEntry[] = [];
    for (const provider of ["claude", "codex"] as CliProvider[]) {
      const found = this.findBinary(provider);
      const lookup = this.lookup(provider);
      const bareCodex = provider === "codex" && lookup.ok && lookup.bin === "codex";
      const resolved = found.ok ? found.bin : null;
      let signedIn = false;
      let account: string | null = null;
      let detail = "";
      if (!found.ok && !bareCodex) {
        detail = found.error ?? `${PROVIDER_LABEL[provider]} was not found on this machine.`;
      } else {
        const probed = await this.probeFn(provider);
        signedIn = probed.signedIn;
        account = probed.account ?? null;
        detail = probed.signedIn ? "" : redactSecrets(probed.detail ?? "");
      }
      out.push({
        provider,
        name: PROVIDER_LABEL[provider],
        installed: Boolean(resolved) || signedIn,
        signedIn,
        account,
        path: resolved,
        detail,
      });
    }
    return out;
  }

  /** The default probe: the two CLIs' own status commands. */
  private async defaultProbe(provider: CliProvider): Promise<CliProbeResult> {
    const found = this.lookup(provider);
    if (!found.ok) {
      return { signedIn: false, detail: found.error ?? `${PROVIDER_LABEL[provider]} is not installed.` };
    }
    const bin = found.bin;
    if (provider === "claude") {
      const run = await this.runCommand(bin, ["auth", "status", "--json"], "claude");
      let parsed: { loggedIn?: boolean; email?: string; subscriptionType?: string };
      try {
        parsed = JSON.parse(run.stdout) as typeof parsed;
      } catch {
        return {
          signedIn: false,
          detail: "Signed out. Sign in and the app can use Claude Code again.",
        };
      }
      if (!(run.code === 0 && parsed.loggedIn)) {
        return {
          signedIn: false,
          detail: "Signed out. Sign in and the app can use Claude Code again.",
        };
      }
      const plan = parsed.subscriptionType?.trim();
      const email = parsed.email?.trim();
      const account = [email, plan ? `${plan} plan` : ""].filter(Boolean).join(" · ");
      return { signedIn: true, ...(account ? { account } : {}) };
    }
    const run = await this.runCommand(bin, ["login", "status"], "codex");
    if (run.code === 0) return { signedIn: true, account: "signed in" };
    return {
      signedIn: false,
      detail: run.timedOut
        ? "Codex login check timed out."
        : "Codex is signed out. Sign in and the app can use Codex again.",
    };
  }

  private runCommand(
    bin: string,
    args: string[],
    provider: CliProvider,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      let child: SpawnedChild;
      try {
        const plan = spawnPlan(bin, args);
        child = this.spawnFn(plan.command, plan.args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv(provider, this.env),
        });
      } catch {
        resolve({ code: null, stdout: "", stderr: "", timedOut: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child.pid, child);
        finish(null);
      }, this.probeTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      child.stdout?.on("data", (chunk) => (stdout = appendTail(stdout, chunk)));
      child.stderr?.on("data", (chunk) => (stderr = appendTail(stderr, chunk)));
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(typeof code === "number" ? code : null));
    });
  }
}
