import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostId, rigwellHome } from "../storage/paths.ts";
import { configuredSecretValues, redactSharedText, redactSharedValue } from "../sharing/redact.ts";
import type { SyncConfig } from "./config.ts";
import { hashFiles, unlinkedPath, type SyncItem } from "./target.ts";
export { hashFiles } from "./target.ts";

export const itemKey = (kind: string, id: string) => {
  if (!["session", "automation", "mission", "workstream", "settings"].includes(kind) || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid sync item key");
  return `${kind}/${id}`;
};
const names = (dir: string) => existsSync(dir) ? (unlinkedPath(dir), readdirSync(dir).filter((n) => /^[a-zA-Z0-9_-]+$/.test(n) && !lstatSync(join(dir, n)).isSymbolicLink() && lstatSync(join(dir, n)).isDirectory())) : [];
export function collectSnapshot(config: SyncConfig, options: { home?: string; owner?: string; secrets?: string[] } = {}): SyncItem[] {
  const home = options.home ?? rigwellHome(), owner = options.owner ?? hostId();
  const secrets = options.secrets ?? configuredSecretValues(process.cwd()), result: SyncItem[] = [];
  const add = (kind: string, id: string, dir: string, allowed: string[]) => {
    const files: Record<string, string> = {};
    for (const name of allowed) {
      const file = join(dir, name); if (!existsSync(file)) continue; unlinkedPath(file);
      const stat = lstatSync(file); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`Sync file is not a bounded regular file: ${name}`);
      const text = readFileSync(file, "utf8");
      if (name.endsWith(".json")) files[name] = JSON.stringify(redactSharedValue(JSON.parse(text), secrets));
      else if (name.endsWith(".jsonl")) files[name] = text.split("\n").filter(Boolean).map((line) => JSON.stringify(redactSharedValue(JSON.parse(line), secrets))).join("\n") + "\n";
      else files[name] = redactSharedText(text, secrets);
    }
    if (Object.keys(files).length) result.push({ key: itemKey(kind, id), owner, hash: hashFiles(files), revision: crypto.randomUUID(), updatedAt: Date.now(), files });
  };
  if (config.kinds.includes("session")) {
    const root = join(home, "sessions");
    // Project slugs may start with '-' and are separate from safe session IDs.
    for (const slug of existsSync(root) ? readdirSync(unlinkedPath(root)) : []) {
      const dir = join(root, slug); unlinkedPath(dir); if (!lstatSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) if (/^[a-zA-Z0-9_-]+\.jsonl$/.test(name)) {
        const id = name.slice(0, -6); add("session", id, dir, [name, `${id}.settings.json`]);
      }
    }
  }
  if (config.kinds.includes("automation")) for (const id of names(join(home, "automations"))) add("automation", id, join(home, "automations", id), ["HEARTBEAT.md", "memory.md", "state.json"]);
  if (config.kinds.includes("mission")) for (const id of names(join(home, "missions"))) add("mission", id, join(home, "missions", id), ["state.json", "features.json", "mission.md", "validation-contract.md", "validation-state.json", "progress_log.jsonl", "handoffs.jsonl"]);
  if (config.kinds.includes("workstream")) for (const id of names(join(home, "workstreams"))) add("workstream", id, join(home, "workstreams", id), ["workstream.json", "roster.json", "listeners.json", "messages.jsonl", "events.jsonl"]);
  if (config.kinds.includes("settings") && config.settings.length) {
    const file = join(home, "settings.json"); unlinkedPath(file);
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const selected = Object.fromEntries(config.settings.filter((key) => ["string", "boolean", "number"].includes(typeof settings[key])).map((key) => [key, redactSharedValue(settings[key], secrets)]));
    const files = { "settings.json": JSON.stringify(selected) }; result.push({ key: "settings/user", owner, hash: hashFiles(files), revision: crypto.randomUUID(), updatedAt: Date.now(), files });
  }
  return result;
}
