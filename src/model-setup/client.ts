// Copied from model-setup-kit 204ad42. Do not edit here; change the kit and copy again.
/*
  The contract screens call. A host implements it over its own wire and adds
  its own storage (`saveChoice`, `listSaved`, `saveSecret`). The core never
  reads or stores credentials.
*/

import type { LocalCatalog } from "./core/local-discovery.ts";
import type { CliAttempt, CliProvider, CliStatusEntry } from "./core/cli-signin.ts";
import type { OllamaSignInState, OllamaStatusResult } from "./core/ollama.ts";
import type {
  ConnectionTestResult,
  NormalizedConnection,
} from "./core/connections.ts";

export type ModelChoice =
  | { kind: "local"; baseUrl: string; model: string; displayName?: string }
  | { kind: "cli"; provider: CliProvider; model: string }
  | {
      kind: "connection";
      name: string;
      baseUrl: string;
      model: string;
      apiKeySecretName?: string;
    };

export type ConnectionRequest = Pick<NormalizedConnection, "baseUrl" | "apiKey">;
export type TestRequest = Pick<NormalizedConnection, "baseUrl" | "apiKey" | "modelId">;

export type CliTestResult = { ok: boolean; detail: string };

/** Whether a pick was written, or an identical entry was already saved. */
export type SaveChoiceResult = { status: "saved" | "exists" };

export interface ModelSetupClient {
  /** The local catalog. `force` re-probes now. */
  catalog(force?: boolean): Promise<LocalCatalog>;

  cliStatus(): Promise<CliStatusEntry[]>;
  cliStart(provider: CliProvider): Promise<CliAttempt>;
  cliPoll(id: number): Promise<CliAttempt | null>;
  cliCancel(id: number): Promise<CliAttempt | null>;
  /** One tiny real call. Optional: a host may not offer it. */
  cliTest?(provider: CliProvider): Promise<CliTestResult>;

  ollamaStatus(): Promise<OllamaStatusResult>;
  ollamaSignInStart(): Promise<OllamaSignInState>;
  ollamaSignInPoll(): Promise<OllamaSignInState | null>;
  ollamaSignInCancel(): Promise<OllamaSignInState | null>;

  discoverModels(connection: ConnectionRequest): Promise<string[]>;
  testConnection(connection: TestRequest): Promise<ConnectionTestResult>;

  /** Model ids a signed-in CLI offers. The kit hard-codes none. */
  listCliModels(provider: CliProvider): Promise<string[]>;

  /** Host storage: the picked model. `exists` means an identical entry was already there. */
  saveChoice(choice: ModelChoice): Promise<SaveChoiceResult>;
  /** Host storage: what is saved, to mark "This app uses this". */
  listSaved(): Promise<ModelChoice[]>;
  /** Host storage for a connection's key; the kit never reads it back. */
  saveSecret(name: string, value: string): Promise<void>;

  /** Whether the host can store the "use whatever is loaded" sentinel. */
  readonly supportsLoadedSentinel: boolean;
}
