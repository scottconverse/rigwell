// Rigwell glue for the model-setup kit: the `model_setup_*` daemon methods.
// Screens call these over the daemon control connection; the kit core does the work.
// One CliSignIn and one OllamaSignIn instance live for the whole daemon process.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import { findNativeExecutable, nativeEnvironment } from "../adapters/native-cli.ts";
import { secretValue } from "../secrets/store.ts";
import {
  refreshCatalog,
  type LocalCatalog,
} from "./core/local-discovery.ts";
import {
  CliSignIn,
  PROVIDER_LABEL,
  type CliAttempt,
  type CliProbeResult,
  type CliProvider,
  type CliStatusEntry,
} from "./core/cli-signin.ts";
import {
  OllamaSignIn,
  ollamaStatus,
  type OllamaSignInState,
  type OllamaStatusResult,
} from "./core/ollama.ts";
import {
  discoverModels,
  normalizeConnection,
  testConnection,
  type ConnectionTestResult,
} from "./core/connections.ts";

export type ModelSetupMethodsDeps = {
  catalog(force: boolean): Promise<LocalCatalog>;
  cli: Pick<CliSignIn, "status" | "start" | "poll" | "cancel">;
  ollamaSignIn: Pick<OllamaSignIn, "start" | "poll" | "cancel">;
  ollamaStatus(): Promise<OllamaStatusResult>;
  discover(connection: { baseUrl: string; apiKey?: string }): Promise<string[]>;
  test(connection: { baseUrl: string; modelId: string; apiKey?: string }): Promise<ConnectionTestResult>;
  /** Model ids a signed-in CLI offers. Read-only; no CLI is run for this. */
  cliModels(provider: CliProvider): string[];
  secret(name: string): string | undefined;
};

/**
 * The `model = "..."` value from Codex's own config, or none. Codex always gets
 * an explicit `--model`, so the config's value is the only "default" there is.
 * Reads that one line with a regex and no other file; never throws.
 */
export function readCodexModel(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dir = env.CODEX_HOME?.trim() || join(home, ".codex");
  let text: string;
  try {
    text = readFileSync(join(dir, "config.toml"), "utf8");
  } catch {
    return [];
  }
  const found = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]?.trim();
  return found ? [found] : [];
}

/** The probe Rigwell already trusts before a native CLI turn: the signed-in subscription, not any key. */
export async function rigwellCliProbe(provider: CliProvider): Promise<CliProbeResult> {
  const backend = provider === "claude" ? "claude-cli" : "codex-cli";
  const bin = findNativeExecutable(backend);
  if (!bin) {
    return { signedIn: false, detail: `${PROVIDER_LABEL[provider]} was not found on this machine.` };
  }
  const args = provider === "claude" ? ["auth", "status", "--json"] : ["login", "status"];
  const run = await runStatus(bin, args);
  if (provider === "claude") {
    let state: { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string } | undefined;
    try { state = JSON.parse(run.stdout) as typeof state; } catch { /* not JSON: signed out */ }
    if (!state?.loggedIn || state.authMethod !== "claude.ai") {
      return { signedIn: false, detail: "Signed out. Sign in and the app can use Claude Code again." };
    }
    const account = [state.email?.trim(), state.subscriptionType?.trim() ? `${state.subscriptionType.trim()} plan` : ""]
      .filter(Boolean)
      .join(" · ");
    return { signedIn: true, ...(account ? { account } : {}) };
  }
  if (/logged in.*chatgpt/is.test(run.stdout + run.stderr)) return { signedIn: true, account: "signed in" };
  return { signedIn: false, detail: "Codex is signed out. Sign in and the app can use Codex again." };
}

function runStatus(bin: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: nativeEnvironment() });
    } catch {
      resolve({ stdout: "", stderr: "" });
      return;
    }
    let stdout = "", stderr = "", settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", finish);
    child.on("close", finish);
  });
}

const requireString = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new RpcError(ErrorCodes.INVALID_PARAMS, `${what} is required`);
  return v.trim();
};

const requireId = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, "A sign-in attempt id is required");
  }
  return v;
};

const requireProvider = (v: unknown): CliProvider => {
  if (v !== "claude" && v !== "codex") throw new RpcError(ErrorCodes.INVALID_PARAMS, "provider must be claude or codex");
  return v;
};

/** The key for discover/test: a stored secret by name, else one typed just now. Never logged. */
function apiKeyFrom(p: Record<string, unknown>, deps: ModelSetupMethodsDeps): string | undefined {
  const name = typeof p.apiKeySecretName === "string" && p.apiKeySecretName.trim() ? p.apiKeySecretName.trim() : undefined;
  if (name) {
    const stored = deps.secret(name);
    if (stored === undefined) throw new RpcError(ErrorCodes.INVALID_PARAMS, `No stored secret named ${JSON.stringify(name)}`);
    return stored;
  }
  return typeof p.apiKey === "string" && p.apiKey ? p.apiKey : undefined;
}

/** The same URL rules as the kit's connection form: http(s), no credentials, no query, no fragment. */
function connectionInput(p: Record<string, unknown>, deps: ModelSetupMethodsDeps) {
  const baseUrl = requireString(p.baseUrl, "baseUrl");
  const apiKey = apiKeyFrom(p, deps);
  try {
    return normalizeConnection({ name: "Model setup", baseUrl, ...(apiKey ? { apiKey } : {}) });
  } catch (e) {
    throw new RpcError(ErrorCodes.INVALID_PARAMS, e instanceof Error ? e.message : "Invalid base URL");
  }
}

export function createModelSetupMethods(deps: ModelSetupMethodsDeps) {
  return async function handleModelSetupMethod(
    method: string,
    p: Record<string, unknown>,
  ): Promise<{ handled: false } | { handled: true; result: unknown }> {
    switch (method) {
      case "model_setup_catalog":
        return { handled: true, result: await deps.catalog(p.force === true) };
      case "model_setup_cli_status":
        return { handled: true, result: { providers: await deps.cli.status() } };
      case "model_setup_cli_start":
        return { handled: true, result: await deps.cli.start(requireProvider(p.provider)) };
      case "model_setup_cli_poll":
        return { handled: true, result: await deps.cli.poll(requireId(p.id)) };
      case "model_setup_cli_cancel":
        return { handled: true, result: await deps.cli.cancel(requireId(p.id)) };
      case "model_setup_ollama_status":
        return { handled: true, result: await deps.ollamaStatus() };
      case "model_setup_ollama_signin_start":
        return { handled: true, result: await deps.ollamaSignIn.start() };
      case "model_setup_ollama_signin_poll":
        return { handled: true, result: deps.ollamaSignIn.poll() };
      case "model_setup_ollama_signin_cancel":
        return { handled: true, result: deps.ollamaSignIn.cancel() };
      case "model_setup_cli_models":
        return { handled: true, result: { models: deps.cliModels(requireProvider(p.provider)) } };
      case "model_setup_discover": {
        const connection = connectionInput(p, deps);
        return { handled: true, result: { models: await deps.discover(connection) } };
      }
      case "model_setup_test": {
        const connection = connectionInput(p, deps);
        const modelId = requireString(p.modelId, "modelId");
        return { handled: true, result: await deps.test({ ...connection, modelId }) };
      }
      default:
        return { handled: false };
    }
  };
}

/* ── One sign-in runner per daemon process ─────────────────────────────── */
const cliSignIn = new CliSignIn({ probe: rigwellCliProbe, appName: "Rigwell" });
const ollamaSignIn = new OllamaSignIn();

export const handleModelSetupMethod = createModelSetupMethods({
  catalog: (force) => refreshCatalog(force),
  cli: cliSignIn,
  ollamaSignIn,
  ollamaStatus: () => ollamaStatus(),
  discover: (connection) => discoverModels(connection),
  test: (connection) => testConnection(connection),
  cliModels: (provider) => (provider === "claude" ? ["sonnet", "opus", "haiku"] : readCodexModel()),
  secret: (name) => secretValue(name),
});

export type { CliAttempt, CliProvider, CliStatusEntry, OllamaSignInState, OllamaStatusResult };
