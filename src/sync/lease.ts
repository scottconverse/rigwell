import { join } from "node:path";
import { hostId, rigwellHome } from "../storage/paths.ts";
import { readSyncConfig, syncRoot, type SyncConfig } from "./config.ts";
import { SyncRepository } from "./target.ts";

export const LEASE_MS = 60_000;
/** Kept for the engine lifetime: an idle engine still holds an in-memory transcript. */
export class SessionLease {
  private token = crypto.randomUUID();
  private renewing?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private lost = false;
  private pending?: Promise<void>;
  private held = false;
  private ownedUntil = 0;
  get owned() { return this.held && !this.lost && this.ownedUntil > Date.now(); }
  assertOwned() { if (!this.owned) throw new Error("Session ownership expired; close and reload the session"); }
  private repository: SyncRepository;
  constructor(readonly key: string, readonly owner: string, config: SyncConfig, home: string, private onLost: () => void, private ttl = LEASE_MS) {
    this.repository = new SyncRepository(config.leaseTarget ?? config.target, join(syncRoot(home), "lease-git"));
  }
  async acquire() {
    if (this.lost) throw new Error("Session ownership was lost; close and reload the session before continuing");
    if (this.held) { this.assertOwned(); return; }
    await this.write(true); this.held = true;
    this.renewing = setInterval(() => {
      if (!this.pending) this.pending = this.write(false).catch(() => this.lose()).finally(() => { this.pending = undefined; });
    }, Math.max(10, Math.floor(this.ttl / 4)));
    this.renewing.unref();
  }
  private async write(first: boolean) {
    const before = Date.now(), expiresAt = before + this.ttl;
    await this.repository.transaction((d) => {
      const prior = d.leases[this.key];
      if (first ? prior && prior.expiresAt > Date.now() && prior.token !== this.token : !prior || prior.token !== this.token || prior.expiresAt <= Date.now()) throw new Error(`Session is owned by ${prior?.owner ?? "another machine"}`);
      d.leases[this.key] = { owner: this.owner, token: this.token, expiresAt };
    });
    if (this.lost || Date.now() >= expiresAt) { this.lose(); throw new Error("Session lease expired while contacting its authority"); }
    this.ownedUntil = expiresAt;
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.lose(), Math.max(1, expiresAt - Date.now())); this.deadline.unref();
  }
  private lose() { if (!this.lost) { this.lost = true; clearInterval(this.renewing); clearTimeout(this.deadline); this.onLost(); } }
  async release() {
    clearInterval(this.renewing); clearTimeout(this.deadline);
    await this.pending;
    if (!this.held) return;
    this.held = false;
    await this.repository.transaction((d) => { if (d.leases[this.key]?.token === this.token) delete d.leases[this.key]; });
  }
}
export function configuredSessionLease(id: string, onLost: () => void, home = rigwellHome()): SessionLease | undefined {
  const config = readSyncConfig(home); if (!config?.kinds.includes("session")) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid synced session id");
  return new SessionLease(`session/${id}`, hostId(), config, home, onLost);
}
