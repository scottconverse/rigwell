// Remote execution keeps the same local admission owner, caps and usage acknowledgments.
import type { AutonomyLevel, ModelConfig, Tool, ToolOutput, TokenUsage } from "../core/types.ts";
import type { RpcPeer } from "../protocol/rpc.ts";
import { METHOD_PREFIX } from "../protocol/rpc.ts";
import { watchRemoteFiles } from "./file-watch.ts";

export class RemoteMemberRole {
  readonly sessionId: string;
  readonly maxAutonomy: AutonomyLevel;
  readonly maxToolIds?: string[];
  private tools: Omit<Tool, "run">[];
  private allowedModels?: string[];
  private sharedPath?: string;
  private watches = new Map<string, () => void>();
  constructor(p: Record<string, unknown>, private peer: RpcPeer) {
    if (typeof p.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(p.sessionId)) throw new Error("Invalid member session ID");
    if (!["off", "low", "medium", "high"].includes(p.maxAutonomy as string)) throw new Error("Invalid member autonomy cap");
    if (p.maxToolIds !== undefined && (!Array.isArray(p.maxToolIds) || !p.maxToolIds.every((s) => typeof s === "string"))) throw new Error("Invalid member tool cap");
    if (!Array.isArray(p.tools) || p.tools.length > 20 || p.tools.some((t) => !t || typeof t.name !== "string" || typeof t.description !== "string" || !t.inputSchema || typeof t.inputSchema !== "object")) throw new Error("Invalid member control tools");
    const allowed = new Set(["ListAgents", "SendMessage", "CreateListener", "SpawnAgent", "InterruptAgent", "RenameAgent", "ArchiveAgent"]);
    if (p.tools.some((t) => !allowed.has(t.name))) throw new Error("Unknown member control tool");
    this.sessionId = p.sessionId;
    this.maxAutonomy = p.maxAutonomy as AutonomyLevel;
    this.maxToolIds = p.maxToolIds as string[] | undefined;
    this.tools = p.tools;
    if (p.allowedModels !== undefined && (!Array.isArray(p.allowedModels) || !p.allowedModels.every((s) => typeof s === "string"))) throw new Error("Invalid priced model list");
    this.allowedModels = p.allowedModels as string[] | undefined;
    if (p.sharedPath !== undefined && (typeof p.sharedPath !== "string" || !p.sharedPath || /[\r\n\0]/.test(p.sharedPath))) throw new Error("Invalid shared folder");
    this.sharedPath = p.sharedPath as string | undefined;
  }
  wrap(base: Tool[]): Tool[] {
    const names = new Set(this.tools.map((t) => t.name));
    for (const name of ["ProposeWorkstream", "SpawnAgent", "ListAgents", "SendMessage", "CreateListener", "WaitForEvents", "InterruptAgent", "RenameAgent", "ArchiveAgent"]) names.add(name);
    const shared = base.map((tool): Tool => {
      if (!this.sharedPath || !["Read", "Create", "Edit"].includes(tool.name)) return tool;
      const root = this.sharedPath.replaceAll("\\", "/").replace(/\/$/, "");
      return { ...tool, run: async (input, ctx) => {
        const path = typeof input.path === "string" ? input.path.replaceAll("\\", "/") : "";
        if (path === root || path.startsWith(root + "/")) return await this.peer.request(METHOD_PREFIX + "owned_member_shared_file", { name: tool.name, input }) as ToolOutput;
        return tool.run(input, ctx);
      } };
    });
    return [...shared.filter((t) => !names.has(t.name)), ...this.tools.map((t): Tool => ({ ...t, category: "other", run: async (input) => await this.peer.request(METHOD_PREFIX + "owned_member_tool", { name: t.name, input }) as ToolOutput }))];
  }
  beforeTurn = async (signal: AbortSignal) => {
    const id = crypto.randomUUID();
    const cancel = () => this.peer.notify(METHOD_PREFIX + "owned_member_cancel_admission", { id });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw new Error("Member admission cancelled");
      const grant = await this.peer.request(METHOD_PREFIX + "owned_member_admit", { id }) as { allowedModels?: string[] };
      this.allowedModels = grant.allowedModels;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; this.peer.notify(METHOD_PREFIX + "owned_member_release", { id });
      };
      if (signal.aborted) { release(); throw new Error("Member admission cancelled"); }
      return release;
    } finally { signal.removeEventListener("abort", cancel); }
  };
  beforeModel = (model: ModelConfig) => {
    if (this.allowedModels && !this.allowedModels.includes(model.id)) throw new Error("A cost budget requires an explicit configured price before a model request");
  };
  onUsage = async (modelId: string, usage: TokenUsage) => {
    await this.peer.request(METHOD_PREFIX + "owned_member_usage", { modelId, usage });
  };
  watchFiles(id: unknown, glob: unknown, root: string, log?: (m: string) => void) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || typeof glob !== "string") throw new Error("Invalid remote file watch");
    this.unwatch(id);
    this.watches.set(id, watchRemoteFiles(root, glob, (event) => this.peer.notify(METHOD_PREFIX + "owned_member_file_changed", { id, ...event }), log));
  }
  unwatch(id: string) { this.watches.get(id)?.(); this.watches.delete(id); }
  close() { for (const stop of this.watches.values()) stop(); this.watches.clear(); }
}
