// Per-model profiles (spec 4.1). A profile is data in config, not code: a conservative default, overlaid by
// settings `modelProfiles` ("*" for all models, then the model's id or API name), then by the custom model's own
// `profile` object. Fields:
//   toolExecutionMode          direct_only | script_only (settings scriptToolModels and a per-session override win)
//   promptVariant              text appended as one more system block after the base prompt
//   toolDescriptionOverrides   { ToolName: "description" } replaces the description sent to the model
//   readLineNumbers            always | on_request (Read numbers lines by default when "always")
//   reasoningField             reasoning | reasoning_content, for OpenAI-compatible adapters
//   cache.strategy             anthropic-breakpoints | openai-auto | none
//   fileEditToolProfile        apply-patch | create-edit (spec 4.6.4)
//   textVerbosity              low | medium | high      Responses text.verbosity
//   serviceTier                string                   Responses service_tier (auto, default, flex, priority)
//   safetyIdentifier           string | true            Responses safety_identifier (true: the session id)
//   extendedCache              boolean                  Responses prompt_cache_retention "24h", only against OpenAI's own base URL
import type { ModelConfig, ToolExecutionMode } from "../core/types.ts";

export type CacheStrategy = "anthropic-breakpoints" | "openai-auto" | "none";
export type FileEditToolProfile = "apply-patch" | "create-edit";

export interface ModelProfile {
  toolExecutionMode: ToolExecutionMode;
  promptVariant: string;
  toolDescriptionOverrides: Record<string, string>;
  readLineNumbers: "always" | "on_request";
  reasoningField?: "reasoning" | "reasoning_content";
  cache: { strategy: CacheStrategy };
  fileEditToolProfile: FileEditToolProfile;
  textVerbosity?: "low" | "medium" | "high";
  serviceTier?: string;
  safetyIdentifier?: string | true;
  extendedCache?: boolean;
}

export interface ProfileSettings {
  modelProfiles?: Record<string, Partial<ModelProfile> & { cache?: Partial<ModelProfile["cache"]> }>;
  fileEditToolProfile?: FileEditToolProfile;
}

/** OpenAI-made model names: they default to the ApplyPatch profile (spec 4.6.4). */
export const isOpenAIMade = (m: Pick<ModelConfig, "provider" | "model">) => m.provider === "openai" && /^(gpt-|o\d|codex|chatgpt)/i.test(m.model);

/** The conservative default: direct tools, no overlay, lines numbered on request, provider-native caching. */
export function defaultProfile(m: Pick<ModelConfig, "provider" | "model">): ModelProfile {
  return {
    toolExecutionMode: "direct_only", promptVariant: "", toolDescriptionOverrides: {}, readLineNumbers: "on_request",
    cache: { strategy: m.provider === "anthropic" ? "anthropic-breakpoints" : "openai-auto" },
    fileEditToolProfile: isOpenAIMade(m) ? "apply-patch" : "create-edit",
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function overlay(base: ModelProfile, over: unknown): ModelProfile {
  if (!isObj(over)) return base;
  const out: ModelProfile = { ...base, toolDescriptionOverrides: { ...base.toolDescriptionOverrides }, cache: { ...base.cache } };
  if (over.toolExecutionMode === "direct_only" || over.toolExecutionMode === "script_only") out.toolExecutionMode = over.toolExecutionMode;
  if (typeof over.promptVariant === "string") out.promptVariant = over.promptVariant;
  if (isObj(over.toolDescriptionOverrides)) {
    for (const [k, v] of Object.entries(over.toolDescriptionOverrides)) if (typeof v === "string") out.toolDescriptionOverrides[k] = v;
  }
  if (over.readLineNumbers === "always" || over.readLineNumbers === "on_request") out.readLineNumbers = over.readLineNumbers;
  if (over.reasoningField === "reasoning" || over.reasoningField === "reasoning_content") out.reasoningField = over.reasoningField;
  if (isObj(over.cache) && ["anthropic-breakpoints", "openai-auto", "none"].includes(over.cache.strategy as string)) out.cache.strategy = over.cache.strategy as CacheStrategy;
  if (over.fileEditToolProfile === "apply-patch" || over.fileEditToolProfile === "create-edit") out.fileEditToolProfile = over.fileEditToolProfile;
  if (over.textVerbosity === "low" || over.textVerbosity === "medium" || over.textVerbosity === "high") out.textVerbosity = over.textVerbosity;
  if (typeof over.serviceTier === "string" && over.serviceTier) out.serviceTier = over.serviceTier;
  if (over.safetyIdentifier === true || (typeof over.safetyIdentifier === "string" && over.safetyIdentifier)) out.safetyIdentifier = over.safetyIdentifier as string | true;
  if (typeof over.extendedCache === "boolean") out.extendedCache = over.extendedCache;
  return out;
}

export function resolveProfile(model: ModelConfig | undefined, s: ProfileSettings = {}): ModelProfile {
  const m = model ?? { provider: "anthropic" as const, model: "" };
  let p = defaultProfile(m);
  // Settings key fileEditToolProfile applies to every model; a model's own value wins.
  if (s.fileEditToolProfile) p = overlay(p, { fileEditToolProfile: s.fileEditToolProfile });
  const table = s.modelProfiles ?? {};
  p = overlay(p, table["*"]);
  if (model) {
    p = overlay(p, table[model.model]);
    p = overlay(p, table[model.id]);
    p = overlay(p, model.profile);
    if (model.fileEditToolProfile) p = overlay(p, { fileEditToolProfile: model.fileEditToolProfile });
    if (model.reasoningField) p = overlay(p, { reasoningField: model.reasoningField });
  }
  return p;
}
