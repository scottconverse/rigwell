// Custom Models (BYOK) form logic (spec §4.6, §12.2). Entries mirror the customModels settings array.
// The page only ever sees masked secrets: a value that still starts with the mask means "unchanged".
export const MASK = "****";
export interface ModelForm {
  model: string; displayName: string; provider: "anthropic" | "openai" | "google" | "generic-chat-completion-api" | "bedrock-converse"; baseUrl: string;
  apiKey: string; maxOutputTokens: string; maxContextLimit: string; reasoningEffort: string; noImageSupport: boolean; headers: { key: string; value: string }[];
  credentialSource: string;
  bedrock?: Record<string, string>;
  original?: Record<string, unknown>;
}
export const PROVIDERS: { id: ModelForm["provider"]; label: string; baseUrl: string }[] = [
  { id: "anthropic", label: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
  { id: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "generic-chat-completion-api", label: "Chat Completions (local or API)", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "bedrock-converse", label: "Amazon Bedrock Converse", baseUrl: "" },
];
export const emptyForm = (): ModelForm => ({ model: "", displayName: "", provider: "anthropic", baseUrl: PROVIDERS[0].baseUrl, apiKey: "", credentialSource: "", maxOutputTokens: "", maxContextLimit: "", reasoningEffort: "", noImageSupport: false, headers: [] });

export function toForm(e: Record<string, any>): ModelForm {
  return {
    model: e.model ?? "", displayName: e.displayName ?? "", provider: PROVIDERS.find((p) => p.id === e.provider)?.id ?? "anthropic", baseUrl: e.baseUrl ?? "", apiKey: e.apiKey ?? "",
    credentialSource: e.credentialSource ?? "", ...(e.bedrock ? { bedrock: { ...e.bedrock } } : {}), original: { ...e },
    maxOutputTokens: e.maxOutputTokens ? String(e.maxOutputTokens) : "", maxContextLimit: e.maxContextLimit ? String(e.maxContextLimit) : "", reasoningEffort: e.reasoningEffort ?? "",
    noImageSupport: e.noImageSupport === true || (e.noImageSupport === undefined && e.provider === "generic-chat-completion-api"), headers: Object.entries(e.extraHeaders ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

const posInt = (s: string) => /^\d+$/.test(s.trim()) && Number(s) > 0;

export function validate(f: ModelForm): string | null {
  if (!f.model.trim()) return "The model name is required.";
  if (f.credentialSource && f.apiKey.trim()) return "Account sign-in cannot be combined with an API key.";
  if (f.provider === "bedrock-converse" && !f.bedrock) return "Bedrock settings are required.";
  if (f.bedrock) {
    if (!f.bedrock.awsRegion?.trim()) return "The AWS region is required.";
    if (f.bedrock.awsAuthMethod === "profile" && !f.bedrock.awsProfile?.trim()) return "The AWS profile is required.";
    if (f.bedrock.awsAuthMethod === "credentials-command" && !f.bedrock.awsCredentialExport?.trim()) return "The AWS credential export command is required.";
  }
  if (f.baseUrl.trim() ? !/^https?:\/\/\S+$/.test(f.baseUrl.trim()) : !f.bedrock && f.provider !== "google" && !f.credentialSource) return "The base URL must start with http:// or https://.";
  for (const [label, v] of [["Max output tokens", f.maxOutputTokens], ["Context limit", f.maxContextLimit]] as const) if (v.trim() && !posInt(v)) return `${label} must be a whole number above zero.`;
  for (const h of f.headers) if (h.key.trim() === "" && h.value !== "") return "A header needs a name.";
  return null;
}

export function toEntry(f: ModelForm): Record<string, unknown> {
  const e: Record<string, unknown> = { ...f.original, model: f.model.trim(), provider: f.provider };
  // Remove cleared form fields, while preserving unrelated adapter/profile options.
  for (const k of ["baseUrl", "displayName", "apiKey", "credentialSource", "bedrock", "maxOutputTokens", "maxContextLimit", "reasoningEffort", "noImageSupport", "extraHeaders"]) delete e[k];
  if (f.baseUrl.trim()) e.baseUrl = f.baseUrl.trim();
  if (f.displayName.trim()) e.displayName = f.displayName.trim();
  if (f.credentialSource) { e.credentialSource = f.credentialSource; delete e.apiKeyHelper; }
  else if (f.apiKey.trim()) e.apiKey = f.apiKey.trim();
  if (f.bedrock) e.bedrock = Object.fromEntries(Object.entries(f.bedrock).filter(([, v]) => v.trim()));
  if (posInt(f.maxOutputTokens)) e.maxOutputTokens = Number(f.maxOutputTokens);
  if (posInt(f.maxContextLimit)) e.maxContextLimit = Number(f.maxContextLimit);
  if (f.reasoningEffort) e.reasoningEffort = f.reasoningEffort;
  if (f.noImageSupport || f.provider === "generic-chat-completion-api") e.noImageSupport = f.noImageSupport;
  const headers = f.headers.filter((h) => h.key.trim());
  if (headers.length) e.extraHeaders = Object.fromEntries(headers.map((h) => [h.key.trim(), h.value]));
  return e;
}

export const isMasked = (v: string) => v.startsWith(MASK);
/** What the key field shows: the mask, an env reference, or nothing. */
export const keyHint = (v: string) => (!v ? "No key set" : v.startsWith("${") ? `Read from ${v}` : "Saved (hidden)");
