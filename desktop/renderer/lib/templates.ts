// Automation templates, VISUAL.html and guided setup (docs/automations.md). Pure helpers for the Automations pages.
import type { RunRow } from "./automations.ts";

export interface TemplateParam { key: string; label: string; description?: string; default?: string }
export interface TemplateRow { id: string; name: string; description: string; category: string; schedule?: string; autonomy?: string; parameters: TemplateParam[]; instructions?: string }

/** Templates grouped by category, categories in the order they first appear. */
export function groupTemplates(list: TemplateRow[]): { category: string; templates: TemplateRow[] }[] {
  const by = new Map<string, TemplateRow[]>();
  for (const t of list) by.set(t.category, [...(by.get(t.category) ?? []), t]);
  return [...by].map(([category, templates]) => ({ category, templates }));
}

export const defaultParams = (t: TemplateRow): Record<string, string> => Object.fromEntries(t.parameters.map((p) => [p.key, p.default ?? ""]));

/** Instructions with the current parameter values filled in (a parameter with no value stays as {{key}}). */
export function previewInstructions(t: TemplateRow, values: Record<string, string>): string {
  return (t.instructions ?? "").replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, k) => (values[k]?.trim() ? values[k] : m));
}

/** create_automation params for a template: parameters without a default are required. */
export function templateCreate(t: TemplateRow, values: Record<string, string>, o: { workingDirectory?: string; name?: string }): { params: Record<string, unknown> } | { error: string } {
  const missing = t.parameters.filter((p) => p.default === undefined && !values[p.key]?.trim());
  if (missing.length) return { error: `Fill in: ${missing.map((p) => p.label).join(", ")}.` };
  const parameters = Object.fromEntries(t.parameters.map((p) => [p.key, (values[p.key]?.trim() || p.default) ?? ""]));
  return { params: { templateId: t.id, parameters, ...(o.workingDirectory?.trim() ? { workingDirectory: o.workingDirectory.trim() } : {}), ...(o.name?.trim() ? { name: o.name.trim() } : {}) } };
}

/** The VISUAL page should be fetched again soon: a run is in progress. */
export const visualStale = (runs: Pick<RunRow, "status">[]) => runs.some((r) => r.status === "in_progress");

/** What the review card shows for the CreateAutomation permission request (confirmation type exec, details.toolName CreateAutomation). */
export function setupCard(use: any): { title: string; lines: string[] } | null {
  const d = use?.details ?? {};
  if (d.toolName !== "CreateAutomation" && use?.toolUse?.name !== "CreateAutomation") return null;
  const input = d.input ?? use?.toolUse?.input ?? {};
  const lines: string[] = [];
  const add = (label: string, v: unknown) => { if (v !== undefined && v !== null && String(v) !== "") lines.push(`${label}: ${String(v)}`); };
  add("Name", input.name); add("Schedule", input.schedule ?? input.trigger); add("Time zone", input.timezone); add("Folder", input.workingDirectory ?? input.projectDir); add("Model", input.model);
  add("Instructions", input.instructions);
  return { title: "Create this automation?", lines };
}
