// Attention events (spec §19.1): turns session notifications and harness-to-client requests into "this session needs
// you" events that the desktop shows as OS notifications and plays sounds for.
//
// The daemon's connection layer is owned by another phase, so this mapping lives here as plain functions and a small
// tracker. The desktop main process feeds it every message it relays (it sees both directions), which is equivalent to
// the daemon doing it for connected windows. Moving the tracker into the daemon later needs no change to the events.
export type AttentionKind = "attention_requested" | "attention_resolved" | "source_terminated";
export type RequestKind = "ask_user" | "permission" | "session_completion" | "mission_attention" | "mission_completion";
export type AttentionCategory = "questions_and_approvals" | "agent_turn_complete" | "mission_needs_input" | "mission_complete";

export interface AttentionEvent {
  kind: AttentionKind;
  requestKind?: RequestKind;
  category?: AttentionCategory;
  sessionId: string;
  summary: string;
  detail: string;
  /** Request id this event resolves or belongs to. */
  requestId?: string;
  /** Turn finished for a reason other than success. */
  failed?: boolean;
  /** Completed with `cancelled`: no sound, no notification. */
  cancelled?: boolean;
  at: number;
}

const CATEGORY: Record<RequestKind, AttentionCategory> = {
  ask_user: "questions_and_approvals", permission: "questions_and_approvals", session_completion: "agent_turn_complete",
  mission_attention: "mission_needs_input", mission_completion: "mission_complete",
};
export const categoryOf = (k: RequestKind) => CATEGORY[k];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "..." : s);
const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find((l) => l.length > 2 && !/^[#>*`\-\s]*$/.test(l)) ?? "";

/** One short sentence for a permission request, naming the kind of action. */
export function permissionSummary(params: Record<string, any>): { summary: string; detail: string } {
  const use = (params.toolUses ?? [])[0];
  const count = (params.toolUses ?? []).length;
  if (!use) return { summary: "Approval needed", detail: "" };
  const d = use.details ?? {};
  const name = use.toolUse?.name ?? "tool";
  switch (use.confirmationType) {
    case "exec": {
      if (use.toolUse?.name === "Browser") return { summary: "Wants to use the browser pane", detail: JSON.stringify(use.toolUse.input ?? {}) };
      const risk = d.riskLevel ? ` (${d.riskLevel} risk)` : "";
      const cmd = String(d.fullCommand ?? d.command ?? use.toolUse?.input?.command ?? name);
      return { summary: `Run a command${risk}: ${clip(cmd, 80)}`, detail: [cmd, d.riskLevelReason].filter(Boolean).join("\n") };
    }
    case "edit": return { summary: `Edit ${d.fileName ?? "a file"}`, detail: String(d.filePath ?? "") };
    case "create": return { summary: `Create ${d.fileName ?? "a file"}`, detail: String(d.filePath ?? "") };
    case "apply_patch": return { summary: `Apply a patch to ${d.fileCount ?? count} files`, detail: "" };
    case "mcp_tool": return { summary: `Use ${d.toolName ?? name} from ${d.serverName ?? "an MCP server"}`, detail: "" };
    case "exit_spec_mode": return { summary: "Approve the plan", detail: "" };
    default: return { summary: count > 1 ? `Approve ${count} operations` : `Approve ${name}`, detail: "" };
  }
}

export function askUserSummary(params: Record<string, any>): { summary: string; detail: string } {
  const q = (params.questions ?? [])[0];
  return { summary: q?.question ? `Question: ${clip(String(q.question), 90)}` : "The agent has a question", detail: (params.questions ?? []).map((x: any) => x.question).join("\n") };
}

/** Per-connection tracker. Feed it relayed traffic; it returns events to act on. */
export class AttentionTracker {
  private lastText = new Map<string, { messageId: string; text: string }>();
  private open = new Map<string, AttentionEvent>(); // by requestId

  /** A request from the harness to the client (rigwell.request_permission / ask_user / pick_options). */
  onRequest(sessionId: string, method: string, requestId: string, params: Record<string, any>): AttentionEvent | undefined {
    let s: { summary: string; detail: string }, rk: RequestKind;
    if (method === "request_permission") { s = permissionSummary(params); rk = "permission"; }
    else if (method === "ask_user" || method === "pick_options") { s = method === "ask_user" ? askUserSummary(params) : { summary: String(params.title ?? "Choose an option"), detail: "" }; rk = "ask_user"; }
    else return undefined;
    const ev: AttentionEvent = { kind: "attention_requested", requestKind: rk, category: CATEGORY[rk], sessionId, summary: s.summary, detail: s.detail, requestId, at: Date.now() };
    this.open.set(requestId, ev);
    return ev;
  }

  /** A session_notification. */
  onNotification(sessionId: string, n: Record<string, any>): AttentionEvent[] {
    switch (n.type) {
      case "assistant_text_delta": {
        const cur = this.lastText.get(sessionId);
        if (!cur || cur.messageId !== n.messageId) this.lastText.set(sessionId, { messageId: n.messageId, text: String(n.textDelta ?? "") });
        else cur.text += String(n.textDelta ?? "");
        return [];
      }
      case "create_message": {
        const text = (n.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        if (n.message?.role === "assistant" && text) this.lastText.set(sessionId, { messageId: String(n.message.id), text });
        return [];
      }
      case "permission_resolved": {
        const out: AttentionEvent[] = [];
        const id = String(n.requestId ?? "");
        const open = this.open.get(id);
        if (open) { this.open.delete(id); out.push({ kind: "attention_resolved", requestKind: open.requestKind, category: open.category, sessionId, summary: open.summary, detail: "", requestId: id, at: Date.now() }); }
        return out;
      }
      case "agent_turn_completed": {
        const reason = String(n.reason ?? "completed");
        const text = this.lastText.get(sessionId)?.text ?? "";
        this.lastText.delete(sessionId);
        const failed = reason !== "completed" && reason !== "cancelled";
        const summary = reason === "cancelled" ? "Stopped" : failed ? `The turn ended: ${reason.replace(/_/g, " ")}` : (firstLine(text) ? clip(firstLine(text), 120) : "Finished");
        return [{ kind: "attention_requested", requestKind: "session_completion", category: "agent_turn_complete", sessionId, summary, detail: clip(text, 600), failed, cancelled: reason === "cancelled", at: Date.now() }];
      }
      case "session_process_exited":
        return [{ kind: "source_terminated", sessionId, summary: "The agent process exited", detail: String(n.message ?? ""), at: Date.now() }];
      default: return [];
    }
  }

  /** The client answered or the request was cancelled. */
  resolve(sessionId: string, requestId: string): AttentionEvent | undefined {
    const open = this.open.get(requestId);
    if (!open) return undefined;
    this.open.delete(requestId);
    return { kind: "attention_resolved", requestKind: open.requestKind, category: open.category, sessionId, summary: open.summary, detail: "", requestId, at: Date.now() };
  }
}
