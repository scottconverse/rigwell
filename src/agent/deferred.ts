// Deferred tools (spec §6.2): announced by name in an appended reminder, loaded on demand with
// load_tools (or tools.ToolSearch / tools.load_tools inside a Script), called with call_tool in
// direct_only mode or as tools.<name> inside a Script. The request's `tools` array never changes.
import type { Tool, ToolOutput } from "../core/types.ts";
import { PROMPT_TEXT } from "./prompt-text.generated.ts";

export interface LoadedEntry { name: string; signature: string; description: string }

/** `name({ a: string, b?: number })` from a JSON schema's top-level properties. */
export function signatureOf(tool: Pick<Tool, "name" | "inputSchema">): string {
  const props = ((tool.inputSchema as any)?.properties ?? {}) as Record<string, any>;
  const req = new Set<string>(((tool.inputSchema as any)?.required ?? []) as string[]);
  const ty = (s: any): string => {
    if (!s || typeof s !== "object") return "any";
    if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join("|");
    if (s.type === "array") return `${ty(s.items)}[]`;
    return typeof s.type === "string" ? s.type : Array.isArray(s.type) ? s.type.join("|") : "any";
  };
  const fields = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${ty(v)}`);
  return `${tool.name}(${fields.length ? `{ ${fields.join(", ")} }` : ""})`;
}

const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();

export interface DeferredState { loaded: string[]; announced: string[] }

export class DeferredRegistry {
  private tools = new Map<string, Tool>();
  private loaded = new Set<string>();
  private announced = new Set<string>();
  private notices: string[] = [];

  constructor(init?: Partial<DeferredState>) {
    for (const n of init?.loaded ?? []) this.loaded.add(n);
    for (const n of init?.announced ?? []) this.announced.add(n);
  }

  register(tool: Tool): void { this.tools.set(tool.name, tool); }
  unregister(name: string): void { this.tools.delete(name); }
  names(): string[] { return [...this.tools.keys()].sort(); }
  get(name: string): Tool | undefined { return this.tools.get(name); }
  isLoaded(name: string): boolean { return this.loaded.has(name); }
  /** Names loaded so far, including ones whose tool is not registered right now (an MCP server that dropped). */
  loadedNames(): string[] { return [...this.loaded].sort(); }
  loadedTools(): Tool[] { return this.loadedNames().map((n) => this.tools.get(n)).filter((t): t is Tool => !!t); }
  size(): number { return this.tools.size; }
  state(): DeferredState { return { loaded: this.loadedNames(), announced: [...this.announced].sort() }; }

  /**
   * Reminder for tools that became available or went away since the last one, or null.
   * The first one lists every name; later ones are small deltas. Marks the names announced.
   */
  announcement(): string | null {
    const now = new Set(this.tools.keys());
    const added = [...now].filter((n) => !this.announced.has(n)).sort();
    const gone = [...this.announced].filter((n) => !now.has(n)).sort();
    if (!added.length && !gone.length) return null;
    const first = this.announced.size === 0 && gone.length === 0;
    this.announced = now;
    if (first) {
      return `<system-reminder>\nDeferred tools (names only, schemas are not sent until loaded). Load the ones you need with load_tools, then call them with call_tool or, inside a Script, as tools.<name>:\n${added.join(", ")}\n</system-reminder>`;
    }
    const parts: string[] = [];
    if (added.length) parts.push(`Deferred tools now available: ${added.join(", ")}.`);
    if (gone.length) parts.push(`Deferred tools no longer available: ${gone.join(", ")}.`);
    return `<system-reminder>\n${parts.join(" ")}\n</system-reminder>`;
  }

  /** Loads exact names. Already loaded names are returned again but not announced again. */
  load(names: string[]): { loaded: LoadedEntry[]; unknown: string[] } {
    const loaded: LoadedEntry[] = [];
    const unknown: string[] = [];
    const fresh: LoadedEntry[] = [];
    for (const name of names) {
      const t = this.tools.get(name);
      if (!t) { unknown.push(name); continue; }
      const entry = { name, signature: signatureOf(t), description: firstLine(t.description) };
      loaded.push(entry);
      if (!this.loaded.has(name)) { this.loaded.add(name); fresh.push(entry); }
    }
    if (fresh.length) {
      const lines = fresh.map((e) => `- ${e.signature}: ${e.description}`);
      this.notices.push(`<system-reminder>\nTools loaded. Call them with call_tool({ name, args }), or inside a Script as tools.<name>(args) (an MCP tool server__tool is tools.server.tool):\n${lines.join("\n")}\n</system-reminder>`);
    }
    return { loaded, unknown };
  }

  /** Keyword search (all words must occur in name or description) or "select:a,b". Loads the matches. */
  search(query: string, limit = 5): { loaded: LoadedEntry[]; more: number; unknown?: string[] } {
    const q = query.trim();
    if (/^select:/i.test(q)) {
      const r = this.load(q.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
      return { loaded: r.loaded, more: 0, ...(r.unknown.length ? { unknown: r.unknown } : {}) };
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [...this.tools.values()]
      .map((t) => {
        const hay = `${t.name} ${t.description}`.toLowerCase();
        const nameHay = t.name.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return null;
        return { t, score: words.reduce((a, w) => a + (nameHay.includes(w) ? 2 : 1), 0) };
      })
      .filter((x): x is { t: Tool; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    const take = scored.slice(0, Math.max(1, Math.min(20, limit)));
    const r = this.load(take.map((x) => x.t.name));
    return { loaded: r.loaded, more: scored.length - take.length };
  }

  takeNotices(): string[] { return this.notices.splice(0); }

  /**
   * One reminder for the first message after a compaction: the loaded tools with their signatures (they stay loaded) and
   * the names still deferred. Marks everything announced so later reminders are deltas. Null when there are none.
   */
  reinjection(): string | null {
    const loaded = this.loadedTools();
    const rest = this.names().filter((n) => !this.loaded.has(n));
    this.announced = new Set(this.tools.keys());
    this.notices = [];
    if (!loaded.length && !rest.length) return null;
    const parts: string[] = [];
    if (loaded.length) {
      parts.push(`Tools loaded earlier in this session (still loaded). Call them with call_tool({ name, args }), or inside a Script as tools.<name>(args):\n${loaded.map((t) => `- ${signatureOf(t)}: ${firstLine(t.description)}`).join("\n")}`);
    }
    if (rest.length) parts.push(`Deferred tools (names only, load with load_tools): ${rest.join(", ")}`);
    return `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
  }

  /** The load_tools tool (direct tool in direct_only, binding inside a Script). */
  loadToolsTool(): Tool {
    return {
      name: "load_tools",
      description: PROMPT_TEXT.tool_load_tools_desc,
      inputSchema: JSON.parse(PROMPT_TEXT.tool_load_tools_schema),
      category: "other",
      run: async (input): Promise<ToolOutput> => {
        const names = input.names;
        if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== "string")) {
          return { content: "names must be a non-empty array of tool names.", isError: true };
        }
        const r = this.load(names as string[]);
        return { content: JSON.stringify(r), data: r };
      },
    };
  }

  /** ToolSearch: only reachable inside a Script. */
  toolSearchTool(): Tool {
    return {
      name: "ToolSearch",
      description: PROMPT_TEXT.tool_ToolSearch_desc,
      inputSchema: JSON.parse(PROMPT_TEXT.tool_ToolSearch_schema),
      category: "other",
      run: async (input): Promise<ToolOutput> => {
        if (typeof input.query !== "string" || !input.query.trim()) return { content: "query is required.", isError: true };
        const limit = typeof input.limit === "number" ? input.limit : 5;
        const r = this.search(input.query, limit);
        return { content: JSON.stringify(r), data: r };
      },
    };
  }

  /** call_tool: direct-mode way to call a loaded deferred tool without touching the tools array. */
  callToolTool(): Tool {
    return {
      name: "call_tool",
      description:
        "Calls a deferred tool that you have loaded with load_tools.\n- name: the tool name, exactly as loaded.\n- args: the arguments object for that tool, as its signature shows.\nA tool that is not loaded, or is no longer available, returns an error that says so.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, args: { type: "object" } },
        required: ["name"],
        additionalProperties: false,
      },
      category: "other",
      run: async (input, ctx) => {
        const t = this.resolveCallable(String(input.name ?? ""));
        if (typeof t === "string") return { content: t, isError: true };
        return t.run((input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>, ctx);
      },
    };
  }

  /** The tool to run for `name`, or an error text. */
  resolveCallable(name: string): Tool | string {
    const t = this.tools.get(name);
    if (!t) {
      return this.loaded.has(name)
        ? `Tool ${name} was loaded but is not available right now.`
        : `Unknown tool: ${name}. Deferred tools: ${this.names().join(", ") || "none"}.`;
    }
    if (!this.loaded.has(name)) return `Tool ${name} is not loaded. Call load_tools({ names: ["${name}"] }) first.`;
    return t;
  }
}
