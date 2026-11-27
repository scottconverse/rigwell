// Rigwell's ModelSetupClient: the kit screens over the daemon's `model_setup_*` methods,
// with picks saved as ordinary `customModels` entries through the same helpers the
// Custom Models page uses. It never reads a key back from the daemon.
import type {
  CliAttempt,
  CliProvider,
  CliStatusEntry,
} from "../../../../src/model-setup/core/cli-signin.ts";
import { inferKind, type LocalCatalog } from "../../../../src/model-setup/core/local-discovery.ts";
import type { OllamaSignInState, OllamaStatusResult } from "../../../../src/model-setup/core/ollama.ts";
import type { ConnectionTestResult } from "../../../../src/model-setup/core/connections.ts";
import type { ConnectionRequest, ModelChoice, ModelSetupClient, TestRequest } from "../../../../src/model-setup/client.ts";
import { emptyForm, toEntry, validate, type ModelForm } from "../../lib/custom-models.ts";
import { secretNameFor } from "../../../../src/model-setup/secret-name.ts";
import { SERVER_KIND_LABEL, isLoopbackUrl } from "./kit/helpers.ts";

/** What the client needs from the app: one request over the daemon, settings read and saved. */
export interface ModelSetupHost {
  request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  settings(): Record<string, any>;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
  refresh(): Promise<unknown>;
}

const KEYCHAIN_SECRET = "keychain:secret:";

/** The entry the Custom Models page would have written for this form, or a readable error. */
function entryFor(form: ModelForm): Record<string, unknown> {
  const bad = validate(form);
  if (bad) throw new Error(bad);
  return toEntry(form);
}

const entryKey = (entry: Record<string, any>) =>
  `${String(entry.provider ?? "")}|${String(entry.baseUrl ?? "")}|${String(entry.model ?? "")}`;

function choiceForEntry(entry: Record<string, any>): ModelChoice | null {
  const model = typeof entry.model === "string" ? entry.model : "";
  if (!model) return null;
  if (entry.executionBackend === "claude-cli") return { kind: "cli", provider: "claude", model };
  if (entry.executionBackend === "codex-cli") return { kind: "cli", provider: "codex", model };
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "";
  if (!baseUrl) return null;
  if (typeof entry.apiKey === "string" && entry.apiKey.startsWith(KEYCHAIN_SECRET)) {
    return {
      kind: "connection",
      name: typeof entry.displayName === "string" && entry.displayName ? entry.displayName : model,
      baseUrl,
      model,
      apiKeySecretName: entry.apiKey.slice(KEYCHAIN_SECRET.length),
    };
  }
  if (isLoopbackUrl(baseUrl)) {
    return {
      kind: "local",
      baseUrl,
      model,
      ...(typeof entry.displayName === "string" && entry.displayName ? { displayName: entry.displayName } : {}),
    };
  }
  return null;
}

export function createModelSetupClient(host: ModelSetupHost): ModelSetupClient {
  async function listCliModels(provider: CliProvider): Promise<string[]> {
    // Both CLIs always get an explicit `--model`, so the daemon reads what it
    // can: the fixed aliases for Claude Code, Codex's own config for Codex.
    const r = await host.request<{ models?: string[] }>("model_setup_cli_models", { provider });
    return r.models ?? [];
  }

  return {
    supportsLoadedSentinel: false,

    async catalog(force = false): Promise<LocalCatalog> {
      return host.request<LocalCatalog>("model_setup_catalog", { force });
    },

    async cliStatus(): Promise<CliStatusEntry[]> {
      const r = await host.request<{ providers?: CliStatusEntry[] }>("model_setup_cli_status");
      return r.providers ?? [];
    },

    cliStart(provider: CliProvider): Promise<CliAttempt> {
      return host.request<CliAttempt>("model_setup_cli_start", { provider });
    },

    cliPoll(id: number): Promise<CliAttempt | null> {
      return host.request<CliAttempt | null>("model_setup_cli_poll", { id });
    },

    cliCancel(id: number): Promise<CliAttempt | null> {
      return host.request<CliAttempt | null>("model_setup_cli_cancel", { id });
    },

    ollamaStatus(): Promise<OllamaStatusResult> {
      return host.request<OllamaStatusResult>("model_setup_ollama_status");
    },

    ollamaSignInStart(): Promise<OllamaSignInState> {
      return host.request<OllamaSignInState>("model_setup_ollama_signin_start");
    },

    ollamaSignInPoll(): Promise<OllamaSignInState | null> {
      return host.request<OllamaSignInState | null>("model_setup_ollama_signin_poll");
    },

    ollamaSignInCancel(): Promise<OllamaSignInState | null> {
      return host.request<OllamaSignInState | null>("model_setup_ollama_signin_cancel");
    },

    async discoverModels(connection: ConnectionRequest): Promise<string[]> {
      const r = await host.request<{ models?: string[] }>("model_setup_discover", {
        baseUrl: connection.baseUrl,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
      });
      return r.models ?? [];
    },

    testConnection(connection: TestRequest): Promise<ConnectionTestResult> {
      return host.request<ConnectionTestResult>("model_setup_test", {
        baseUrl: connection.baseUrl,
        modelId: connection.modelId,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
      });
    },

    listCliModels,

    async saveSecret(name: string, value: string): Promise<void> {
      await host.request("set_secret", { name: secretNameFor(name), value });
    },

    async saveChoice(choice: ModelChoice): Promise<void> {
      let entry: Record<string, unknown>;
      if (choice.kind === "local") {
        const kind = inferKind(choice.baseUrl);
        const displayName = choice.displayName?.trim() || `${choice.model} (${SERVER_KIND_LABEL[kind]})`;
        entry = entryFor({
          ...emptyForm(),
          provider: "generic-chat-completion-api",
          baseUrl: choice.baseUrl,
          model: choice.model,
          displayName,
        });
      } else if (choice.kind === "cli") {
        entry = entryFor({
          ...emptyForm(),
          provider: choice.provider === "claude" ? "anthropic" : "openai",
          executionBackend: choice.provider === "claude" ? "claude-cli" : "codex-cli",
          model: choice.model,
          displayName: choice.model,
        });
      } else {
        entry = entryFor({
          ...emptyForm(),
          provider: "generic-chat-completion-api",
          baseUrl: choice.baseUrl,
          model: choice.model,
          displayName: choice.name,
          ...(choice.apiKeySecretName ? { apiKey: `${KEYCHAIN_SECRET}${secretNameFor(choice.apiKeySecretName)}` } : {}),
        });
      }
      const list: Record<string, any>[] = Array.isArray(host.settings().customModels) ? host.settings().customModels : [];
      // The same provider, base URL and model already saved: keep the old entry.
      const next = list.some((item) => entryKey(item) === entryKey(entry)) ? list.slice() : [...list, entry];
      if (next.length !== list.length) await host.updateSettings({ customModels: next });
      await host.refresh();
    },

    async listSaved(): Promise<ModelChoice[]> {
      const list: Record<string, any>[] = Array.isArray(host.settings().customModels) ? host.settings().customModels : [];
      return list.flatMap((entry) => {
        const choice = choiceForEntry(entry);
        return choice ? [choice] : [];
      });
    },
  };
}
