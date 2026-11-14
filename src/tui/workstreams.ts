import type { View, ViewCtx } from "./views.ts";
import { words } from "./views.ts";
import type { AgentEntry, Workstream, WorkstreamMessage } from "../workstreams/store.ts";

export async function workstreamsView(args: string, c: ViewCtx): Promise<View> {
  const w = words(args), action = w[0];
  try {
    if (!action) {
      const r = await c.request("list_workstreams", {});
      return { title: "Workstreams", lines: [], workstreams: r.workstreams };
    }
    let id = action;
    if (action === "send" || action === "interrupt") {
      const all: Workstream[] = (await c.request("list_workstreams", {})).workstreams;
      const chosen = all.find((s) => s.id === c.state.workstreamId) ?? all.find((s) => s.leadSessionId === c.state.sessionId);
      if (!chosen) return { title: "Workstreams", lines: ["Choose a workstream with /workstreams first."] };
      id = chosen.id;
      if (!w[1] || (action === "send" && !w.slice(2).join(" ").trim())) return { title: "Workstreams", lines: ['Usage: /ws send "agent name" <text> or /ws interrupt "agent name"'] };
      if (action === "send") await c.request("workstream_send", { id, to: w[1], message: w.slice(2).join(" "), priority: "next" });
      else {
        const roster: AgentEntry[] = (await c.request("get_workstream", { id })).roster;
        const agent = roster.find((r) => r.agentId === w[1] || r.name.toLowerCase() === w[1].toLowerCase());
        if (!agent) throw new Error(`Unknown member ${w[1]}`);
        await c.request("workstream_interrupt", { id, agentId: agent.agentId });
      }
    }
    const r: { workstream: Workstream; roster: AgentEntry[]; messages: WorkstreamMessage[] } = await c.request("get_workstream", { id });
    const name = (id: string) => r.roster.find((a) => a.agentId === id)?.name ?? id;
    return { title: `Workstream: ${r.workstream.title}`, workstreamId: id, lines: [
      `${r.workstream.state}: ${r.workstream.goal}`, ...(r.workstream.budget ? [`Budget: ${JSON.stringify(r.workstream.budget)}`] : []), "", "Agents",
      ...r.roster.flatMap((a) => [`${a.name} [${a.status}] ${a.role}`, `  ${a.model} · ${a.branch ?? "shared directory"} · ${a.tokens} tokens · ${a.costKnown === false ? "cost unpriced" : `$${a.costUsd.toFixed(4)} estimated`}`, ...(a.lastSummary ? [`  ${a.lastSummary}`] : [])]),
      "", "Messages", ...r.messages.flatMap((m) => [`${name(m.from)} -> ${name(m.to)} [${m.priority}, ${m.readAt ? "read" : m.deliveredAt ? "delivered" : "queued"}]`, m.text]),
      "", '/ws send "agent name" <text>', '/ws interrupt "agent name"', "Esc closes this view; updates arrive while it is open.",
    ] };
  } catch (e) {
    const message = String((e as Error).message);
    return { title: "Workstreams", lines: [/not found|unknown method/i.test(message) ? "Workstreams require a daemon connection. Start rigwell daemon, then rigwell --daemon." : message] };
  }
}
