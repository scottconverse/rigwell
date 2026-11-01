// Model picker logic (spec §14.3): search, "auto" first, a pinned short list, then grouped by provider.
export interface ModelRow { id: string; displayName?: string; provider?: string; unavailable?: boolean }

export const AUTO = "auto";

/** `list_models` / `availableModels` rows use `modelProvider`; older code used `provider`. */
export function normalizeModel(m: any): ModelRow {
  return { id: String(m.id), displayName: m.displayName ?? m.shortDisplayName ?? m.id, provider: m.modelProvider ?? m.provider, unavailable: m.unavailable === true };
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", "generic-chat-completion-api": "Chat Completions", chat: "Chat Completions" };
export const providerLabel = (p?: string) => (p ? PROVIDER_NAMES[p] ?? p[0].toUpperCase() + p.slice(1) : "Other");

export interface PickerSection { title: string; models: ModelRow[] }

/** Sections in display order. `pinned` ids form a short list after Auto; the rest are grouped by provider. */
export function pickerSections(models: ModelRow[], opts: { query?: string; autoAvailable?: boolean; pinned?: string[] } = {}): PickerSection[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const hit = (m: ModelRow) => !q || `${m.displayName ?? ""} ${m.id} ${m.provider ?? ""}`.toLowerCase().includes(q);
  const out: PickerSection[] = [];
  const hasAuto = models.some((m) => m.id === AUTO);
  const auto: ModelRow | undefined = hasAuto ? models.find((m) => m.id === AUTO) : opts.autoAvailable ? { id: AUTO, displayName: "Auto" } : undefined;
  if (auto && hit(auto)) out.push({ title: "", models: [auto] });
  const rest = models.filter((m) => m.id !== AUTO && hit(m));
  const pinned = (opts.pinned ?? []).map((id) => rest.find((m) => m.id === id)).filter((m): m is ModelRow => !!m);
  if (pinned.length) out.push({ title: "Pinned", models: pinned });
  const groups = new Map<string, ModelRow[]>();
  for (const m of rest.filter((x) => !pinned.includes(x))) groups.set(providerLabel(m.provider), [...(groups.get(providerLabel(m.provider)) ?? []), m]);
  for (const [title, ms] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ title, models: ms });
  return out;
}
