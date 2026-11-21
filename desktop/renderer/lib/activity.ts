// Pure activity model for the session screen: folds runs of tool and thinking items, and names the live step.
import type { Item } from "./transcript.ts";

export type ActivityItem = Extract<Item, { kind: "tool" | "thinking" }>;
export type TranscriptRow =
  | { kind: "item"; item: Item }
  | { kind: "group"; id: string; items: ActivityItem[]; failed: number; autoOpen: boolean };

const isActivity = (item: Item): item is ActivityItem => item.kind === "tool" || item.kind === "thinking";

/** Folds two or more adjacent activity items that hold a tool. A failed tool, or a running tool during a turn, keeps its group open. */
export function groupActivity(items: Item[], working = false): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (let i = 0; i < items.length;) {
    const item = items[i]!;
    if (!isActivity(item)) { rows.push({ kind: "item", item }); i++; continue; }
    const run: ActivityItem[] = [];
    while (i < items.length && isActivity(items[i]!)) run.push(items[i++] as ActivityItem);
    const tools = run.filter((x): x is Extract<ActivityItem, { kind: "tool" }> => x.kind === "tool");
    if (run.length < 2 || !tools.length) { for (const x of run) rows.push({ kind: "item", item: x }); continue; }
    const failed = tools.filter((x) => x.status === "error").length;
    rows.push({ kind: "group", id: `activity-${run[0]!.id}`, items: run, failed, autoOpen: failed > 0 || (working && tools.some((x) => x.status === "running")) });
  }
  return rows;
}

export function activityLabel(group: Extract<TranscriptRow, { kind: "group" }>): string {
  return `Activity · ${group.items.length} events${group.failed ? `, ${group.failed} failed` : ""}`;
}

const STEPS: { names: string[]; verb: string; one: string; many: string }[] = [
  { names: ["Execute"], verb: "Running", one: "command", many: "commands" },
  { names: ["Edit", "Create", "ApplyPatch"], verb: "Making", one: "file change", many: "file changes" },
  { names: ["Read"], verb: "Reading", one: "file", many: "files" },
  { names: ["Grep", "Glob", "LS"], verb: "Running", one: "search", many: "searches" },
  { names: ["FetchUrl"], verb: "Fetching", one: "page", many: "pages" },
];

/** Names the tools that run now. Only the newest activity run counts, so a tool left unfinished by an older turn is ignored. */
export function liveStep(items: Item[]): string {
  const running: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user") { if (running.length) break; continue; } // a message sent during a turn sits after its running tools
    if (!isActivity(item)) break;
    if (item.kind === "tool" && item.status === "running") running.push(item.name);
  }
  if (!running.length) return "Working";
  const parts = STEPS.flatMap((s) => {
    const n = running.filter((name) => s.names.includes(name)).length;
    return n ? [`${s.verb} ${n} ${n === 1 ? s.one : s.many}`] : [];
  });
  const known = new Set(STEPS.flatMap((s) => s.names));
  const other = running.filter((name) => !known.has(name)).length;
  if (other) parts.push(`Using ${other} ${other === 1 ? "tool" : "tools"}`);
  return parts.join(", ");
}
