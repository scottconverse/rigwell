// Pure validation shared with the settings writer and renderer.
export function parseFallbackModels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 300 || id === "auto")) throw new Error("fallbackModels must be an ordered list of at most 32 exact model profile IDs, excluding auto");
  return [...new Set(value)];
}
