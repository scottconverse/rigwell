// The one update state that the Update button and the File menu share. No Electron imports, so every step can be tested.
import type { UpdateCheck } from "./update-feed.ts";

export type UpdateOffer = Extract<UpdateCheck, { status: "available" }>;
export type UpdatePhase = "idle" | "available" | "downloading" | "ready" | "error";
export interface UpdateState { phase: UpdatePhase; version?: string; percent?: number; message?: string; refused?: boolean }
/** `ready` waits for the user's click. `handed-off` means the user finishes outside the app (saved file or browser download). */
export type UpdateFetched = { kind: "ready"; install: () => void } | { kind: "handed-off" };
export interface UpdateDeps {
  check(): Promise<UpdateCheck>;
  fetch(offer: UpdateOffer, progress: (percent: number) => void): Promise<UpdateFetched>;
  isRefusal(error: unknown): boolean;
  publish(state: UpdateState): void;
}

export class UpdateController {
  private current: UpdateState = { phase: "idle" };
  private offer: UpdateOffer | undefined;
  private installer: (() => void) | undefined;
  constructor(private readonly deps: UpdateDeps) {}

  get state(): UpdateState { return this.current; }

  private set(next: UpdateState) { this.current = next; this.deps.publish(next); }

  private fail(error: unknown) {
    this.set({ phase: "error", version: this.offer?.version, message: error instanceof Error ? error.message : String(error), refused: this.deps.isRefusal(error) });
  }

  /** A download in progress or a verified update waiting for restart is never replaced by a later check. */
  async check(): Promise<UpdateCheck> {
    const result = await this.deps.check();
    if (this.current.phase === "downloading" || this.current.phase === "ready") return result;
    if (result.status === "available") { this.offer = result; this.set({ phase: "available", version: result.version }); }
    else if (result.status !== "error") { this.offer = undefined; this.set({ phase: "idle" }); }
    return result;
  }

  async download(): Promise<UpdateState> {
    if ((this.current.phase !== "available" && this.current.phase !== "error") || !this.offer) return this.current;
    const offer = this.offer;
    this.set({ phase: "downloading", version: offer.version });
    try {
      const fetched = await this.deps.fetch(offer, percent => {
        if (this.current.phase === "downloading") this.set({ phase: "downloading", version: offer.version, percent: Math.max(0, Math.min(100, Math.round(percent))) });
      });
      if (fetched.kind === "ready") { this.installer = fetched.install; this.set({ phase: "ready", version: offer.version }); }
      else { this.offer = undefined; this.set({ phase: "idle" }); }
    } catch (error) { this.fail(error); }
    return this.current;
  }

  /** Runs only after the user's click on Restart to install. */
  install(): UpdateState {
    if (this.current.phase !== "ready" || !this.installer) return this.current;
    const run = this.installer;
    try { run(); } catch (error) { this.installer = undefined; this.fail(error); }
    return this.current;
  }
}

/** The words on the Update button. No button in the idle phase. */
export function updateButtonLabel(state: UpdateState): string | undefined {
  switch (state.phase) {
    case "available": return "Update available";
    case "downloading": return state.percent === undefined ? "Downloading" : `Downloading ${state.percent}%`;
    case "ready": return "Restart to install";
    case "error": return state.refused ? "Update refused" : "Update failed";
    default: return undefined;
  }
}
