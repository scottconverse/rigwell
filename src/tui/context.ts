// /context display (spec §13.6): meter line, one 70-cell bar, category list, notes.

export interface ContextStats {
  used: number; limit: number; remaining?: number; accuracy?: string;
  /** Optional category breakdown (estimates). The harness may report it; when absent only the meter is shown. */
  categories?: { name: string; tokens: number }[];
  budget?: number;
  skills?: { name: string; tokens: number }[];
  agents?: { name: string; tokens: number }[];
}

export const CATEGORY_ORDER = [
  "System prompt", "System tools", "MCP tools", "User info", "AGENTS.md", "Custom agents", "Skills", "Messages",
];
const GLYPHS = ["█", "▓", "▒", "■", "▪", "◼", "◆", "▬"];
const BAR = 70;

const fmt = (n: number) => n.toLocaleString("en-US");
const pctText = (used: number, limit: number) => {
  if (!limit) return "?";
  const p = (used / limit) * 100;
  return used > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

export function formatContext(stats: ContextStats | null, modelName: string): string[] {
  const out: string[] = [];
  if (!stats || !stats.used) out.push(`${modelName}  Compaction meter not available yet (no model response in this session)`);
  else out.push(`${modelName}  Compaction meter ${fmt(stats.used)}/${fmt(stats.limit)} tokens (${pctText(stats.used, stats.limit)})`);
  out.push("");
  const limit = stats?.limit ?? 0;
  const cats = stats?.categories;
  if (cats && cats.length && limit) {
    const budget = stats?.budget ?? limit;
    let bar = "";
    cats.forEach((c, i) => { bar += GLYPHS[i % GLYPHS.length].repeat(Math.round((c.tokens / budget) * BAR)); });
    bar = bar.slice(0, BAR);
    out.push(bar + "·".repeat(BAR - [...bar].length));
    out.push("");
    const total = cats.reduce((a, c) => a + c.tokens, 0);
    out.push(`Estimated usage by category · ${fmt(total)}/${fmt(budget)} (${pctText(total, budget)})`);
    const named = new Map(cats.map((c) => [c.name, c.tokens]));
    const ordered = [...CATEGORY_ORDER.filter((n) => named.has(n)), ...cats.map((c) => c.name).filter((n) => !CATEGORY_ORDER.includes(n))];
    ordered.forEach((n) => {
      const i = cats.findIndex((c) => c.name === n);
      const t = named.get(n)!;
      out.push(`  ${GLYPHS[i % GLYPHS.length]} ${n.padEnd(14)} ${fmt(t).padStart(9)} (${pctText(t, budget)})`);
    });
    out.push(`  · ${"Estimated Free Space".padEnd(14)} ${fmt(Math.max(0, budget - total)).padStart(9)}`);
    out.push("");
    out.push("Category totals are estimates; only the meter uses provider-reported numbers.");
    for (const [title, list] of [["Skills", stats?.skills], ["Custom agents", stats?.agents]] as const) {
      if (list?.length) { out.push(""); out.push(`${title}:`); list.forEach((s) => out.push(`  ${s.name}  ${fmt(s.tokens)}`)); }
    }
  } else {
    const used = stats?.used ?? 0;
    const filled = limit ? Math.min(BAR, Math.max(used ? 1 : 0, Math.round((used / limit) * BAR))) : 0;
    out.push("█".repeat(filled) + "·".repeat(BAR - filled));
    out.push("");
    out.push("The category breakdown is not reported by this build; only the provider meter is shown.");
  }
  out.push("");
  out.push("Esc closes this view.");
  return out;
}
