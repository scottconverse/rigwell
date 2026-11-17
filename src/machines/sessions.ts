// Only routing metadata is local. Remote transcripts and credentials stay on their owner.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionListEntry } from "../storage/session-list.ts";
import { isValidSessionId, rigwellHome } from "../storage/paths.ts";
export interface RemoteSessionEntry extends SessionListEntry { machine: string; tokenUsage?: import("../core/types.ts").TokenUsage }
export class RemoteSessionStore {
  constructor(readonly home = rigwellHome()) {}
  list(): RemoteSessionEntry[] {
    const path = join(this.home, "remote-sessions.json");
    if (!existsSync(path)) return [];
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || rows.some((r) => !r || !isValidSessionId(r.sessionId) || typeof r.machine !== "string" || typeof r.cwd !== "string")) throw new Error("Invalid remote session routing index");
    return rows;
  }
  get(id: string) { return this.list().find((r) => r.sessionId === id); }
  update(row: RemoteSessionEntry) {
    const rows = this.list(), index = rows.findIndex((r) => r.sessionId === row.sessionId);
    if (index >= 0 && rows[index]!.machine !== row.machine) throw new Error("Session id is already owned by another remote machine");
    if (index >= 0) rows[index] = row; else rows.push(row);
    mkdirSync(this.home, { recursive: true });
    const path = join(this.home, "remote-sessions.json"), tmp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path);
  }
}
