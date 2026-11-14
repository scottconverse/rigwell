// Pure transcript model for the session screen: stored messages and live notifications become display items.
// User bubbles, markdown text, tool rows (icon, name, main argument), thinking blocks and notices (spec §14.3).

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "ok" | "error"; output?: string; live?: string; phase?: string }
  | { kind: "info"; id: string; text: string; level: "info" | "error" };

/** The main argument of a tool call, for the one-line row. */
export function mainArg(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v) as string | undefined;
  switch (name) {
    case "Read": case "Edit": case "Create": return pick("path", "file_path") ?? "";
    case "Execute": return pick("command") ?? "";
    case "Grep": return pick("pattern") ?? "";
    case "Glob": return pick("pattern") ?? "";
    case "Browser": return [pick("action"), pick("url", "expression", "key")].filter(Boolean).join(" ");
    case "Script": return (pick("code", "script") ?? "").split("\n")[0];
    default: return pick("path", "command", "pattern", "query", "url", "name") ?? "";
  }
}

const ICONS: Record<string, string> = { Read: "R", Edit: "E", Create: "+", Execute: ">", Grep: "?", Glob: "*", Browser: "B", Script: "S" };
export const toolIcon = (name: string) => ICONS[name] ?? "T";

const text = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
  return c === undefined || c === null ? "" : JSON.stringify(c);
};

function upsertTool(items: Item[], id: string, patch: Partial<Extract<Item, { kind: "tool" }>>): Item[] {
  const i = items.findIndex((x) => x.kind === "tool" && x.id === id);
  if (i < 0) return [...items, { kind: "tool", id, name: patch.name ?? "Tool", input: {}, status: "running", ...patch } as Item];
  const out = items.slice();
  out[i] = { ...(items[i] as any), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  return out;
}

/** Items for messages stored in the session (load_session). Hidden (llm_only) and system-reminder-only messages are skipped. */
export function fromMessages(messages: any[]): Item[] {
  let items: Item[] = [];
  for (const m of messages) {
    if (m.visibility === "llm_only") continue;
    for (const [bi, b] of (m.content ?? []).entries()) {
      const id = `${m.id}:${bi}`;
      if (b.type === "text") {
        const t = String(b.text ?? "");
        if (m.role === "user") { if (t.trim() && !/^\s*<system-reminder>/.test(t)) items.push({ kind: "user", id, text: t }); }
        else if (t.trim()) items.push({ kind: "assistant", id, text: t });
      } else if (b.type === "thinking" && b.thinking) items.push({ kind: "thinking", id, text: b.thinking });
      else if (b.type === "tool_use") items = upsertTool(items, b.id, { name: b.name, input: b.input ?? {} });
      else if (b.type === "tool_result") items = upsertTool(items, b.tool_use_id, { status: b.is_error ? "error" : "ok", output: text(b.content) });
    }
  }
  return items;
}

/** Applies one session notification. Unknown types change nothing. */
export function reduce(items: Item[], n: { type: string; [k: string]: any }): Item[] {
  switch (n.type) {
    case "assistant_text_delta": {
      const id = `${n.messageId}:${n.blockIndex}`;
      const last = items.at(-1);
      if (last?.kind === "assistant" && last.id === id) return [...items.slice(0, -1), { ...last, text: last.text + n.textDelta }];
      return [...items, { kind: "assistant", id, text: n.textDelta }];
    }
    case "thinking_text_delta": {
      const id = `${n.messageId}:${n.blockIndex}`;
      const last = items.at(-1);
      if (last?.kind === "thinking" && last.id === id) return [...items.slice(0, -1), { ...last, text: last.text + n.textDelta }];
      return [...items, { kind: "thinking", id, text: n.textDelta }];
    }
    case "tool_call": return upsertTool(items, n.toolUse.id, { name: n.toolUse.name, input: n.toolUse.input ?? {} });
    case "tool_execution_phase_changed": return upsertTool(items, n.toolUseId, { name: n.toolName, phase: n.phase });
    case "tool_progress_update": {
      const u = n.update ?? {};
      const live = typeof u.fullOutput === "string" ? u.fullOutput : typeof u.text === "string" ? u.text : undefined;
      return live === undefined ? items : upsertTool(items, n.toolUseId, { name: n.toolName, live });
    }
    case "tool_result": return upsertTool(items, n.toolUseId, { status: n.isError ? "error" : "ok", output: text(n.content) });
    case "create_message": {
      const m = n.message;
      if (m?.role === "user") return [...items, ...fromMessages([m]).filter((next) => !items.some((i) => i.id === next.id))];
      return m?.role === "assistant" ? [...items, ...fromMessages([m])] : items;
    }
    case "llm_retry": return [...items, { kind: "info", id: `retry-${items.length}`, text: `Model call failed (${n.reason}); retry ${n.attempt}`, level: "info" }];
    case "session_compacted": return [...items, { kind: "info", id: `compact-${items.length}`, text: "Conversation compacted", level: "info" }];
    case "error": return [...items, { kind: "info", id: `err-${items.length}`, text: String(n.message ?? "error"), level: "error" }];
    case "agent_turn_completed":
      return n.reason === "completed" ? items : [...items, { kind: "info", id: `end-${items.length}`, text: `Turn ended: ${String(n.reason).replace(/_/g, " ")}`, level: n.reason === "cancelled" ? "info" : "error" }];
    default: return items;
  }
}

/** Plain-text export for "Copy as Markdown". */
export function toMarkdown(items: Item[]): string {
  return items.map((i) => {
    switch (i.kind) {
      case "user": return `**You**\n\n${i.text}`;
      case "assistant": return i.text;
      case "tool": return `> ${i.name}${mainArg(i.name, i.input) ? ` \`${mainArg(i.name, i.input)}\`` : ""}`;
      case "info": return `_${i.text}_`;
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}
