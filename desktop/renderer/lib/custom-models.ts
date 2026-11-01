// Custom Models (BYOK) form logic (spec §4.6, §12.2). Entries mirror the customModels settings array.
// The page only ever sees masked secrets: a value that still starts with the mask means "unchanged".
export const MASK = "****";
export interface ModelForm {
  model: string; displayName: string; provider: "anthropic" | "openai"; baseUrl: string;
  apiKey: string; maxOutputTokens: string; maxContextLimit: string; reasoningEffort: string; noImageSupport: boolean; headers: { key: string; value: string }[];
}
export const PROVIDERS: { id: ModelForm["provider"]; label: string; baseUrl: string }[] = [
  { id: "anthropic", label: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
];
export const emptyForm = (): ModelForm => ({ model: "", displayName: "", provider: "anthropic", baseUrl: PROVIDERS[0].baseUrl, apiKey: "", maxOutputTokens: "", maxContextLimit: "", reasoningEffort: "", noImageSupport: false, headers: [] });

export function toForm(e: Record<string, any>): ModelForm {
  return {
    model: e.model ?? "", displayName: e.displayName ?? "", provider: e.provider === "openai" ? "openai" : "anthropic", baseUrl: e.baseUrl ?? "", apiKey: e.apiKey ?? "",
    maxOutputTokens: e.maxOutputTokens ? String(e.maxOutputTokens) : "", maxContextLimit: e.maxContextLimit ? String(e.maxContextLimit) : "", reasoningEffort: e.reasoningEffort ?? "",
    noImageSupport: e.noImageSupport === true, headers: Object.entries(e.extraHeaders ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

const posInt = (s: string) => /^\d+$/.test(s.trim()) && Number(s) > 0;

export function validate(f: ModelForm): string | null {
  if (!f.model.trim()) return "The model name is required.";
  if (!/^https?:\/\/\S+$/.test(f.baseUrl.trim())) return "The base URL must start with http:// or https://.";
  for (const [label, v] of [["Max output tokens", f.maxOutputTokens], ["Context limit", f.maxContextLimit]] as const) if (v.trim() && !posInt(v)) return `${label} must be a whole number above zero.`;
  for (const h of f.headers) if (h.key.trim() === "" && h.value !== "") return "A header needs a name.";
  return null;
}

export function toEntry(f: ModelForm): Record<string, unknown> {
  const e: Record<string, unknown> = { model: f.model.trim(), provider: f.provider, baseUrl: f.baseUrl.trim() };
  if (f.displayName.trim()) e.displayName = f.displayName.trim();
  if (f.apiKey.trim()) e.apiKey = f.apiKey.trim();
  if (posInt(f.maxOutputTokens)) e.maxOutputTokens = Number(f.maxOutputTokens);
  if (posInt(f.maxContextLimit)) e.maxContextLimit = Number(f.maxContextLimit);
  if (f.reasoningEffort) e.reasoningEffort = f.reasoningEffort;
  if (f.noImageSupport) e.noImageSupport = true;
  const headers = f.headers.filter((h) => h.key.trim());
  if (headers.length) e.extraHeaders = Object.fromEntries(headers.map((h) => [h.key.trim(), h.value]));
  return e;
}

export const isMasked = (v: string) => v.startsWith(MASK);
/** What the key field shows: the mask, an env reference, or nothing. */
export const keyHint = (v: string) => (!v ? "No key set" : v.startsWith("${") ? `Read from ${v}` : "Saved (hidden)");
