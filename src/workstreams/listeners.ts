import { watch, realpathSync, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorkstreamStore, type ListenerOn, type WorkstreamEvent, type WorkstreamListener } from "./store.ts";

const kinds: ListenerOn[] = ["agent_idle", "agent_turn_completed", "agent_failed", "agent_waiting_input", "message", "all_idle", "file_changed", "timer"];
type WaitResult = { events: WorkstreamEvent[]; timedOut?: boolean; cancelled?: boolean };
interface Waiting { storeId: string; owner: string; check(): void; cancel(): void }

/** One daemon owns scheduling; definitions and fired/wait-read events survive its lifetime. */
export class WorkstreamListeners {
  private handles = new Map<string, () => void>();
  private waiting = new Set<Waiting>();
  private closed = false;
  constructor(private opts: { fire(store: WorkstreamStore, listener: WorkstreamListener, event: WorkstreamEvent): void; log?(text: string): void }) {}

  create(store: WorkstreamStore, owner: string, input: Record<string, unknown>) {
    if (this.closed) throw new Error("Listener service is closed");
    if (!kinds.includes(input.on as ListenerOn)) throw new Error("Invalid listener event");
    const raw = input.filter ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("filter must be an object");
    const filter = raw as WorkstreamListener["filter"];
    for (const key of ["agentId", "name", "to", "glob"] as const) if (filter[key] !== undefined && typeof filter[key] !== "string") throw new Error(`Invalid filter.${key}`);
    if (input.once !== undefined && typeof input.once !== "boolean") throw new Error("once must be boolean");
    if (owner !== "lead" && (input.on !== "message" || (filter.to !== undefined && filter.to !== owner))) throw new Error("Members can listen only for messages addressed to themselves");
    const listener: WorkstreamListener = { id: crypto.randomUUID(), owner, on: input.on as ListenerOn, once: input.once !== false, createdAt: Date.now(), filter: { ...filter }, ...(typeof input.note === "string" ? { note: input.note } : {}) };
    if (owner !== "lead") listener.filter.to = owner;
    if (listener.on === "timer") {
      const ms = listener.filter.afterMs;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || (!listener.once && ms === 0)) throw new Error("timer needs nonnegative filter.afterMs (positive for recurring timers)");
    }
    if (listener.on === "file_changed") this.fileTarget(store, listener);
    store.writeListeners([...store.listeners(), listener]);
    store.event("listener_created", { listenerId: listener.id, owner, on: listener.on });
    try { this.arm(store, listener); }
    catch (error) { store.writeListeners(store.listeners().filter((l) => l.id !== listener.id)); throw error; }
    if (listener.on === "all_idle") queueMicrotask(() => {
      const agents = store.roster().filter((a) => a.status !== "archived");
      if (agents.length && agents.every((a) => a.status === "idle")) this.fire(store, listener, {});
    });
    return { listenerId: listener.id };
  }

  emit(store: WorkstreamStore, on: ListenerOn, trigger: Record<string, unknown> = {}) {
    if (this.closed) return;
    for (const listener of store.listeners()) {
      if (listener.on !== on) continue;
      const f = listener.filter;
      if (f.agentId && trigger.agentId !== f.agentId) continue;
      if (f.name && String(trigger.name ?? "").toLowerCase() !== f.name.toLowerCase()) continue;
      if (on === "message" && trigger.to !== (listener.owner === "lead" ? "lead" : listener.owner)) continue;
      this.fire(store, listener, trigger);
    }
  }

  private fire(store: WorkstreamStore, listener: WorkstreamListener, trigger: Record<string, unknown>) {
    if (this.closed) return;
    if (!store.listeners().some((l) => l.id === listener.id)) return;
    const now = Date.now();
    store.writeListeners(store.listeners().flatMap((l) => l.id !== listener.id ? [l] : listener.once ? [] : [{ ...l, lastFiredAt: now }]));
    if (listener.once) { this.handles.get(listener.id)?.(); this.handles.delete(listener.id); }
    const event = store.event("listener_fired", { listenerId: listener.id, owner: listener.owner, on: listener.on, ...(listener.note ? { note: listener.note } : {}), trigger });
    this.opts.fire(store, listener, event);
    for (const waiting of [...this.waiting]) if (waiting.storeId === store.id && waiting.owner === listener.owner) waiting.check();
  }

  private fileTarget(store: WorkstreamStore, listener: WorkstreamListener) {
    const f = listener.filter;
    if (!f.glob?.trim()) throw new Error("file_changed needs filter.glob");
    const agent = f.agentId || f.name ? store.roster().find((a) => a.agentId === f.agentId || (f.name && a.name.toLowerCase() === f.name.toLowerCase())) : undefined;
    if ((f.agentId || f.name) && !agent?.worktreePath) throw new Error("File listeners need an existing member worktree");
    let root = agent?.worktreePath ?? store.path("shared");
    let pattern = f.glob.replaceAll("\\", "/");
    if (!agent && pattern.startsWith("shared/")) pattern = pattern.slice(7);
    if (isAbsolute(f.glob)) {
      const roots = [store.path("shared"), ...store.roster().flatMap((a) => a.worktreePath ? [a.worktreePath] : [])];
      const allowed = roots.find((r) => { const rel = relative(resolve(r), resolve(f.glob!)); return rel && !rel.startsWith("..") && !isAbsolute(rel); });
      if (!allowed) throw new Error("File listener glob must stay under shared/ or a member worktree");
      root = allowed; pattern = relative(root, f.glob).split(sep).join("/");
    }
    if (pattern.split("/").includes("..")) throw new Error("File listener glob cannot escape its root");
    return { root: realpathSync.native(root), glob: new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`) };
  }

  private arm(store: WorkstreamStore, listener: WorkstreamListener) {
    if (this.closed) return;
    this.handles.get(listener.id)?.(); this.handles.delete(listener.id);
    if (listener.on === "timer") {
      const interval = listener.filter.afterMs!;
      const due = (listener.lastFiredAt ?? listener.createdAt) + interval;
      const timer = setTimeout(() => {
        this.handles.delete(listener.id);
        this.fire(store, listener, { afterMs: interval });
        const current = store.listeners().find((l) => l.id === listener.id);
        if (current) this.arm(store, current);
      }, Math.max(0, due - Date.now()));
      timer.unref?.(); this.handles.set(listener.id, () => clearTimeout(timer));
    } else if (listener.on === "file_changed") {
      const { root, glob } = this.fileTarget(store, listener);
      let watcher: FSWatcher;
      watcher = watch(root, { recursive: true }, (change, filename) => {
        if (!filename) return;
        const name = String(filename).replaceAll("\\", "/");
        if (!glob.match(name)) return;
        const path = resolve(root, name);
        try { const real = realpathSync.native(path), rel = relative(root, real); if (rel.startsWith("..") || isAbsolute(rel)) return; } catch { /* a deleted file still produces a change */ }
        this.fire(store, listener, { path, change });
      });
      watcher.on("error", (e) => this.opts.log?.(`[workstream] File listener ${listener.id}: ${e.message}`));
      watcher.unref(); this.handles.set(listener.id, () => watcher.close());
    }
  }

  rearm(store: WorkstreamStore) {
    for (const listener of store.listeners()) try { this.arm(store, listener); }
    catch (e) { store.event("listener_rearm_failed", { listenerId: listener.id, message: (e as Error).message }); this.opts.log?.(`[workstream] Listener ${listener.id} could not rearm: ${(e as Error).message}`); }
  }
  archive(store: WorkstreamStore) {
    for (const listener of store.listeners()) { this.handles.get(listener.id)?.(); this.handles.delete(listener.id); }
    store.writeListeners([]);
    for (const waiting of [...this.waiting]) if (waiting.storeId === store.id) waiting.cancel();
  }

  wait(store: WorkstreamStore, owner: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<WaitResult> {
    if (this.closed) return Promise.resolve({ events: [], cancelled: true });
    const ids = input.listenerIds;
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))) throw new Error("listenerIds must be an array of ids");
    if (Array.isArray(ids)) {
      const owned = new Set([...store.listeners().filter((l) => l.owner === owner).map((l) => l.id), ...store.events().filter((e) => e.type === "listener_fired" && e.owner === owner).map((e) => e.listenerId)]);
      if (ids.some((id) => !owned.has(id))) throw new Error("Unknown listener or listener belongs to another participant");
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be nonnegative");
    const take = () => {
      const log = store.events();
      const read = new Set(log.filter((e) => e.type === "listener_wait_read" && e.owner === owner).flatMap((e) => e.eventIds as string[]));
      const events = log.filter((e) => e.type === "listener_fired" && e.owner === owner && !read.has(e.id) && (!Array.isArray(ids) || ids.includes(String(e.listenerId))));
      if (events.length) store.event("listener_wait_read", { owner, eventIds: events.map((e) => e.id) });
      return events;
    };
    const ready = take(); if (ready.length) return Promise.resolve({ events: ready });
    if (signal?.aborted) return Promise.resolve({ events: [], cancelled: true });
    return new Promise((resolve) => {
      const finish = (result: WaitResult) => { clearTimeout(timer); this.waiting.delete(waiting); signal?.removeEventListener("abort", waiting.cancel); resolve(result); };
      const waiting: Waiting = { storeId: store.id, owner, check: () => { const events = take(); if (events.length) finish({ events }); }, cancel: () => finish({ events: [], cancelled: true }) };
      const timer = setTimeout(() => finish({ events: [], timedOut: true }), timeoutMs);
      timer.unref?.(); this.waiting.add(waiting); signal?.addEventListener("abort", waiting.cancel, { once: true });
    });
  }
  close() { this.closed = true; for (const close of this.handles.values()) close(); this.handles.clear(); for (const waiting of [...this.waiting]) waiting.cancel(); }
}
