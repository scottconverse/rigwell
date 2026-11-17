import type { TokenUsage } from "../core/types.ts";
import { costOf } from "../eval/cost.ts";
import type { Price } from "../eval/types.ts";
import { loadSettings } from "../storage/settings.ts";
import { WorkstreamStore, type Workstream } from "./store.ts";

export function budgetFrom(value: unknown): Workstream["budget"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("budget must be an object");
  const budget: NonNullable<Workstream["budget"]> = {};
  for (const key of ["maxTokens", "maxCostUsd", "maxWallMinutes"] as const) {
    const n = (value as any)[key];
    if (n !== undefined) {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`Invalid budget.${key}`);
      budget[key] = n;
    }
  }
  return budget;
}

/** Explicit configured prices, including zero for local models; missing prices are never guessed. */
export function pricesFor(store: WorkstreamStore): Record<string, Price> {
  const raw = (loadSettings({ cwd: store.read().cwd }).settings.workstreams as any)?.prices ?? {};
  const prices: Record<string, Price> = {};
  for (const [id, p] of Object.entries(raw) as [string, any][]) {
    if (p && [p.inputPerMtok, p.cachedInputPerMtok, p.outputPerMtok, p.cacheWritePerMtok ?? p.inputPerMtok].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) prices[id] = p;
  }
  return prices;
}
export function usageTotals(usage: Record<string, TokenUsage>, prices: Record<string, Price>) {
  let tokens = 0, costUsd = 0, costKnown = true;
  for (const [model, u] of Object.entries(usage)) {
    tokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    if (!prices[model]) costKnown = false;
    costUsd += costOf({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheCreation: u.cacheCreationTokens }, prices[model]);
  }
  return { tokens, costUsd, costKnown };
}
export function reached(store: WorkstreamStore): string | undefined {
  const w = store.read(), b = w.budget;
  if (!b) return;
  const rows = store.roster();
  if (b.maxTokens !== undefined && rows.reduce((n, a) => n + a.tokens, 0) >= b.maxTokens) return "maxTokens";
  if (b.maxCostUsd !== undefined && rows.reduce((n, a) => n + a.costUsd, 0) >= b.maxCostUsd) return "maxCostUsd";
  if (b.maxWallMinutes !== undefined && Date.now() - w.createdAt >= b.maxWallMinutes * 60_000) return "maxWallMinutes";
}

/** A turn holds a slot through tools and user prompts; every later wake must enter this same queue. */
export class MemberAdmission {
  private slots = new Map<string, Set<string>>();
  private queue: { store: WorkstreamStore; agentId: string; signal: AbortSignal; enter(): void; cancel(): void }[] = [];
  private closed = false;
  constructor(private onEnter: (store: WorkstreamStore, agentId: string) => void) {}
  acquire(store: WorkstreamStore, agentId: string, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const item = { store, agentId, signal, enter: () => {
        signal.removeEventListener("abort", item.cancel);
        const slots = this.slots.get(store.id) ?? new Set<string>(); this.slots.set(store.id, slots); slots.add(agentId);
        this.onEnter(store, agentId);
        let released = false;
        resolve(() => { if (!released) { released = true; slots.delete(agentId); this.pump(); } });
      }, cancel: () => { this.queue = this.queue.filter((x) => x !== item); signal.removeEventListener("abort", item.cancel); reject(new Error("Member admission cancelled")); } };
      if (this.closed || signal.aborted) { item.cancel(); return; }
      this.queue.push(item); signal.addEventListener("abort", item.cancel, { once: true }); this.pump();
    });
  }
  pump() {
    if (this.closed) return;
    for (const item of [...this.queue]) {
      const w = item.store.read();
      if (["archived", "completed"].includes(w.state) || item.store.agent(item.agentId)?.status === "archived") { item.cancel(); continue; }
      if (w.state !== "active" || (this.slots.get(w.id)?.size ?? 0) >= w.settings.maxConcurrentAgents) continue;
      this.queue = this.queue.filter((x) => x !== item); item.enter();
    }
  }
  close() { this.closed = true; for (const item of [...this.queue]) item.cancel(); }
}
