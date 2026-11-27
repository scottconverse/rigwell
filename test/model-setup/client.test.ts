// Rigwell's ModelSetupClient: every pick becomes a normal customModels entry through
// desktop/renderer/lib/custom-models.ts, saved and read back. No daemon, no React.
import { describe, expect, test } from "bun:test";
import { createModelSetupClient, type ModelSetupHost } from "../../desktop/renderer/components/model-setup/rigwell-client.ts";
import { secretNameFor } from "../../src/model-setup/secret-name.ts";
import { toForm, validate } from "../../desktop/renderer/lib/custom-models.ts";

function fakeHost(initial: Record<string, any>[] = []) {
  const state = { userSettings: { customModels: initial } as Record<string, any> };
  const writes: Record<string, unknown>[] = [];
  let refreshes = 0;
  const host: ModelSetupHost = {
    request: async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === "model_setup_cli_models") {
        const models = params?.provider === "claude" ? ["sonnet", "opus", "haiku"] : ["gpt-5-codex"];
        return { models } as T;
      }
      return {} as T;
    },
    settings: () => state.userSettings,
    updateSettings: async (patch) => { writes.push(patch); state.userSettings = { ...state.userSettings, ...patch }; return state.userSettings; },
    refreshUserSettings: async () => {},
    refresh: async () => { refreshes += 1; },
  };
  return { host, state, writes, refreshes: () => refreshes };
}

const saved = (state: { userSettings: Record<string, any> }) => state.userSettings.customModels as Record<string, any>[];

describe("saveChoice writes Rigwell custom models", () => {
  test("a local model becomes a generic chat-completions entry named after its server", async () => {
    const { host, state, writes } = fakeHost();
    const client = createModelSetupClient(host);
    await client.saveChoice({ kind: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3-8b" });
    expect(saved(state)).toHaveLength(1);
    expect(saved(state)[0]).toMatchObject({
      provider: "generic-chat-completion-api",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen3-8b",
      displayName: "qwen3-8b (LM Studio)",
    });
    expect(writes).toHaveLength(1);
  });

  test("a signed-in Claude Code becomes an anthropic claude-cli entry", async () => {
    const { host, state } = fakeHost();
    await createModelSetupClient(host).saveChoice({ kind: "cli", provider: "claude", model: "sonnet" });
    expect(saved(state)[0]).toMatchObject({ provider: "anthropic", executionBackend: "claude-cli", model: "sonnet" });
    expect(saved(state)[0]).not.toHaveProperty("apiKey");
    expect(saved(state)[0]).not.toHaveProperty("baseUrl");
  });

  test("a signed-in Codex becomes an openai codex-cli entry", async () => {
    const { host, state } = fakeHost();
    await createModelSetupClient(host).saveChoice({ kind: "cli", provider: "codex", model: "gpt-5-codex" });
    expect(saved(state)[0]).toMatchObject({ provider: "openai", executionBackend: "codex-cli", model: "gpt-5-codex" });
  });

  test("an API connection stores the key by name and references it with keychain:secret:", async () => {
    const { host, state } = fakeHost();
    const client = createModelSetupClient(host);
    await client.saveSecret("My server", "sk-typed");
    await client.saveChoice({ kind: "connection", name: "My server", baseUrl: "https://models.example.com/v1", model: "big-model", apiKeySecretName: "My server" });
    expect(secretNameFor("My server")).toBe("My-server");
    expect(saved(state)[0]).toMatchObject({
      provider: "generic-chat-completion-api",
      baseUrl: "https://models.example.com/v1",
      model: "big-model",
      displayName: "My server",
      apiKey: "keychain:secret:My-server",
    });
    expect(validate(toForm(saved(state)[0]!))).toBeNull();
  });

  test("a new key on the same connection replaces the saved reference", async () => {
    const { host, state } = fakeHost();
    const client = createModelSetupClient(host);
    const base = { kind: "connection" as const, name: "My server", baseUrl: "https://models.example.com/v1", model: "big-model" };
    await client.saveChoice({ ...base, apiKeySecretName: "model-setup-my-server-aaaaaa" });
    expect(saved(state)[0]?.apiKey).toBe("keychain:secret:model-setup-my-server-aaaaaa");
    const outcome = await client.saveChoice({ ...base, apiKeySecretName: "model-setup-my-server-bbbbbb" });
    expect(outcome).toEqual({ status: "saved" });
    expect(saved(state)).toHaveLength(1);
    expect(saved(state)[0]?.apiKey).toBe("keychain:secret:model-setup-my-server-bbbbbb");
  });

  test("an identical entry is reported as exists and not rewritten", async () => {
    const { host, state, writes } = fakeHost();
    const client = createModelSetupClient(host);
    const choice = { kind: "connection" as const, name: "My server", baseUrl: "https://models.example.com/v1", model: "big-model", apiKeySecretName: "model-setup-my-server-aaaaaa" };
    expect(await client.saveChoice(choice)).toEqual({ status: "saved" });
    expect(await client.saveChoice(choice)).toEqual({ status: "exists" });
    expect(saved(state)).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  test("entries that differ only by execution backend are both kept", async () => {
    const { host, state } = fakeHost([{ provider: "anthropic", model: "sonnet", baseUrl: "" }]);
    const outcome = await createModelSetupClient(host).saveChoice({ kind: "cli", provider: "claude", model: "sonnet" });
    expect(outcome).toEqual({ status: "saved" });
    expect(saved(state)).toHaveLength(2);
  });

  test("entries that differ only by credential source are both kept", async () => {
    const { host, state } = fakeHost([
      {
        provider: "generic-chat-completion-api",
        model: "gpt",
        baseUrl: "https://api.openai.com/v1",
        credentialSource: "openai-oauth",
      },
    ]);
    // A connection entry has no credentialSource, so it must not overwrite the OAuth one.
    await createModelSetupClient(host).saveChoice({
      kind: "connection", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt",
    });
    expect(saved(state)).toHaveLength(2);
  });

  test("settings are re-read before the write, so a pick another window added is kept", async () => {
    // A is on screen; B lands from another window between load and save.
    const { host, state } = fakeHost([
      { provider: "anthropic", executionBackend: "claude-cli", model: "opus" },
    ]);
    let reads = 0;
    host.refreshUserSettings = async () => {
      if (reads++ > 0) return;
      state.userSettings = {
        customModels: [
          ...(state.userSettings.customModels as Record<string, any>[]),
          { provider: "openai", executionBackend: "codex-cli", model: "gpt-5-codex" },
        ],
      };
    };

    const outcome = await createModelSetupClient(host).saveChoice({
      kind: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3-8b",
    });

    expect(outcome).toEqual({ status: "saved" });
    expect(reads).toBe(1);
    const models = saved(state).map((entry) => entry.model);
    expect(models).toEqual(expect.arrayContaining(["opus", "gpt-5-codex", "qwen3-8b"]));
    expect(models).toHaveLength(3);
  });

  test("the same provider, base URL and model is kept once", async () => {
    const { host, state, writes, refreshes } = fakeHost();
    const client = createModelSetupClient(host);
    const choice = { kind: "local" as const, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" };
    await client.saveChoice(choice);
    await client.saveChoice(choice);
    expect(saved(state)).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(refreshes()).toBe(2);
  });
});

describe("listSaved maps settings back to choices", () => {
  test("cli, local and connection entries come back; entries the kit cannot express are skipped", async () => {
    const { host } = fakeHost([
      { provider: "anthropic", executionBackend: "claude-cli", model: "opus" },
      { provider: "openai", executionBackend: "codex-cli", model: "gpt-5-codex" },
      { provider: "generic-chat-completion-api", baseUrl: "http://127.0.0.1:8080/v1", model: "llama3", displayName: "llama3 (llama.cpp)" },
      { provider: "generic-chat-completion-api", baseUrl: "https://models.example.com/v1", model: "big", displayName: "My server", apiKey: "keychain:secret:My-server" },
      { provider: "google", model: "gemini" },
    ]);
    const choices = await createModelSetupClient(host).listSaved();
    expect(choices).toEqual([
      { kind: "cli", provider: "claude", model: "opus" },
      { kind: "cli", provider: "codex", model: "gpt-5-codex" },
      { kind: "local", baseUrl: "http://127.0.0.1:8080/v1", model: "llama3", displayName: "llama3 (llama.cpp)" },
      { kind: "connection", name: "My server", baseUrl: "https://models.example.com/v1", model: "big", apiKeySecretName: "My-server" },
    ]);
  });

  test("the sentinel is not claimed and the host offers no loaded sentinel", async () => {
    const { host } = fakeHost();
    const client = createModelSetupClient(host);
    expect(client.supportsLoadedSentinel).toBe(false);
    expect(await client.listCliModels("claude")).toEqual(["sonnet", "opus", "haiku"]);
    // Codex's model comes from the daemon, which reads it from Codex's own config.
    expect(await client.listCliModels("codex")).toEqual(["gpt-5-codex"]);
  });
});
