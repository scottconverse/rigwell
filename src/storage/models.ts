// BYOK custom models (spec §12.2) -> ModelConfig.
import type { ModelConfig, ProviderKind, ReasoningEffort } from "../core/types.ts";
import type { RigwellSettings } from "./settings.ts";
import { KEYCHAIN_PREFIX, lookupCredential } from "./credentials.ts";
import { parseOAuthProviders, type OAuthProviderConfig } from "../auth/config.ts";

export interface ModelProblem {
  index: number;
  model?: string;
  message: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  shortDisplayName: string;
  modelProvider: ProviderKind;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  isCustom: true;
}

const EFFORTS: ReasoningEffort[] = ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PLACEHOLDER = /(^|[^a-z])(\.\.\.|…)$|your[-_ ]?(api[-_ ]?)?key|^<.*>$|^sk-x+$|^changeme$|^placeholder$/i;
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expand(value: string, env: Record<string, string | undefined>[], missing: string[]): string {
  return value.replace(ENV_REF, (_m, name: string) => {
    for (const e of env) {
      const v = e[name];
      if (v !== undefined && v !== "") return v;
    }
    missing.push(name);
    return "";
  });
}

const posInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Validates every entry; bad ones are skipped and reported (never throws). */
export function validateCustomModels(
  settings: RigwellSettings,
  env: Record<string, string | undefined> = process.env,
): { models: ModelConfig[]; problems: ModelProblem[] } {
  const models: ModelConfig[] = [];
  const problems: ModelProblem[] = [];
  const list = Array.isArray(settings.customModels) ? settings.customModels : [];
  const envs = [env, settings.env ?? {}]; // process env wins over settings.env
  const oauth = parseOAuthProviders(settings.oauthProviders, env);
  list.forEach((raw, index) => {
    const bad = (message: string) => problems.push({ index, model: typeof raw?.model === "string" ? raw.model : undefined, message });
    if (!raw || typeof raw !== "object") return bad("entry is not an object");
    if (typeof raw.model !== "string" || !raw.model.trim()) return bad("model is required");
    if (raw.provider !== "anthropic" && raw.provider !== "openai" && raw.provider !== "generic-chat-completion-api")
      return bad(`unsupported provider ${JSON.stringify(raw.provider)} (supported: anthropic, openai, generic-chat-completion-api)`);
    if (raw.apiProvider !== undefined && (typeof raw.apiProvider !== "string" || !raw.apiProvider.trim())) return bad("apiProvider must be a non-empty string");
    for (const k of ["chatCompletionRequest", "chatCompletionRequestByProvider"] as const)
      if (raw[k] !== undefined && (typeof raw[k] !== "object" || raw[k] === null || Array.isArray(raw[k]))) return bad(`${k} must be an object`);
    // credentialSource (spec 12.2): a connected account plan instead of a key. Not combinable with apiKey or apiKeyHelper.
    let provider: OAuthProviderConfig | undefined;
    if (raw.credentialSource !== undefined) {
      if (typeof raw.credentialSource !== "string" || !raw.credentialSource.trim()) return bad("credentialSource must be a non-empty string");
      if (raw.apiKey !== undefined || raw.apiKeyHelper !== undefined) return bad("credentialSource cannot be combined with apiKey or apiKeyHelper");
      provider = oauth.providers.get(raw.credentialSource);
      if (!provider) return bad(`credentialSource ${JSON.stringify(raw.credentialSource)} is not a valid entry of oauthProviders${oauth.problems.length ? ` (${oauth.problems.join("; ")})` : ""}`);
    }
    const baseUrl = raw.baseUrl === undefined && provider?.apiBaseUrl ? provider.apiBaseUrl : raw.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\/\S+$/.test(baseUrl)) return bad("baseUrl must be an http(s) URL");
    if (raw.reasoningEffort !== undefined && !EFFORTS.includes(raw.reasoningEffort)) return bad(`invalid reasoningEffort ${JSON.stringify(raw.reasoningEffort)}`);
    for (const k of ["maxOutputTokens", "maxContextLimit"] as const)
      if (raw[k] !== undefined && !posInt(raw[k])) return bad(`${k} must be a positive integer`);
    if (raw.noImageSupport !== undefined && typeof raw.noImageSupport !== "boolean") return bad("noImageSupport must be boolean");
    if (raw.extraArgs !== undefined && (typeof raw.extraArgs !== "object" || raw.extraArgs === null || Array.isArray(raw.extraArgs)))
      return bad("extraArgs must be an object");

    const missing: string[] = [];
    let apiKey: string | undefined;
    if (raw.apiKey !== undefined) {
      if (typeof raw.apiKey !== "string") return bad("apiKey must be a string");
      if (raw.apiKey.startsWith(KEYCHAIN_PREFIX)) {
        // A stored key (spec 12.2): `keychain:<name>` is looked up in the credential store.
        const name = raw.apiKey.slice(KEYCHAIN_PREFIX.length).trim();
        const stored = name ? lookupCredential(name) : undefined;
        if (!stored) return bad(`no stored credential named ${JSON.stringify(name)} (store it with: rigwell credential set ${name || "<name>"})`);
        apiKey = stored;
      } else {
      if (PLACEHOLDER.test(raw.apiKey.trim())) return bad("apiKey looks like a placeholder");
      apiKey = expand(raw.apiKey, envs, missing);
      }
      if (!missing.length && PLACEHOLDER.test(apiKey.trim())) return bad("apiKey looks like a placeholder");
    }
    let extraHeaders: Record<string, string> | undefined;
    if (raw.extraHeaders !== undefined) {
      if (typeof raw.extraHeaders !== "object" || raw.extraHeaders === null || Array.isArray(raw.extraHeaders))
        return bad("extraHeaders must be an object");
      const seen = new Set<string>();
      extraHeaders = {};
      for (const [k, v] of Object.entries(raw.extraHeaders)) {
        if (typeof v !== "string") return bad(`extraHeaders.${k} must be a string`);
        const lk = k.toLowerCase();
        if (seen.has(lk)) return bad(`duplicate header name (case-insensitive): ${k}`);
        seen.add(lk);
        extraHeaders[k] = expand(v, envs, missing);
      }
    }
    if (missing.length) return bad(`unset environment variable(s): ${[...new Set(missing)].join(", ")}`);

    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : raw.model;
    models.push({
      id: `custom:${displayName.trim().replace(/\s+/g, "-")}-${index}`,
      model: raw.model,
      displayName,
      provider: raw.provider,
      baseUrl,
      ...(provider ? { oauth: provider } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
      ...(raw.extraArgs ? { extraArgs: raw.extraArgs } : {}),
      ...(raw.maxOutputTokens !== undefined ? { maxOutputTokens: raw.maxOutputTokens } : {}),
      ...(raw.maxContextLimit !== undefined ? { maxContextLimit: raw.maxContextLimit } : {}),
      ...(raw.reasoningEffort !== undefined ? { reasoningEffort: raw.reasoningEffort } : {}),
      // spec 12.2: noImageSupport defaults to true for generic-chat-completion-api, false otherwise
      ...(raw.noImageSupport !== undefined ? { noImageSupport: raw.noImageSupport } : raw.provider === "generic-chat-completion-api" ? { noImageSupport: true } : {}),
      // Profile fields (spec 4.1, 4.6.4): checked where they are used (src/agent/profiles.ts).
      ...(raw.profile && typeof raw.profile === "object" && !Array.isArray(raw.profile) ? { profile: raw.profile as Record<string, unknown> } : {}),
      ...(raw.reasoningField === "reasoning" || raw.reasoningField === "reasoning_content" ? { reasoningField: raw.reasoningField } : {}),
      ...(raw.fileEditToolProfile === "apply-patch" || raw.fileEditToolProfile === "create-edit" ? { fileEditToolProfile: raw.fileEditToolProfile } : {}),
      ...(raw.apiProvider !== undefined ? { apiProvider: raw.apiProvider } : {}),
      ...(raw.chatCompletionRequest ? { chatCompletionRequest: raw.chatCompletionRequest } : {}),
      ...(raw.chatCompletionRequestByProvider ? { chatCompletionRequestByProvider: raw.chatCompletionRequestByProvider } : {}),
    });
  });
  return { models, problems };
}

/** Valid custom models only. Use `validateCustomModels` to also get the problems. */
export function resolveModels(settings: RigwellSettings, env?: Record<string, string | undefined>): ModelConfig[] {
  return validateCustomModels(settings, env).models;
}

/** Exact id first, then the old `custom:<model>` form (first match). */
export function findModel(models: ModelConfig[], id: string): ModelConfig | undefined {
  return models.find((m) => m.id === id) ?? models.find((m) => `custom:${m.model}` === id);
}

export function listModelInfo(models: ModelConfig[]): ModelInfo[] {
  return models.map((m) => {
    const def: ReasoningEffort = m.reasoningEffort ?? "off";
    const supported: ReasoningEffort[] = ["off", "low", "medium", "high"];
    if (!supported.includes(def)) supported.push(def);
    return {
      id: m.id,
      displayName: m.displayName,
      shortDisplayName: m.displayName,
      modelProvider: m.provider,
      supportedReasoningEfforts: supported,
      defaultReasoningEffort: def,
      isCustom: true as const,
    };
  });
}
