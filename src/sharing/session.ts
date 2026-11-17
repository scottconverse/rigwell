import { assertSharedSize, parseSharedSession, SHARE_MAX_BYTES, type SharedSession } from "./format.ts";
export { parseSharedSession, renderSharedSession, SHARE_MAX_BYTES, type SharedSession } from "./format.ts";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rigwellHome, validateSessionId } from "../storage/paths.ts";
import { appendMessage, createSession, loadSession } from "../storage/transcript.ts";
import { configuredSecretValues, redactSharedText, redactSharedValue } from "./redact.ts";
import { writeSessionSettings } from "../storage/session-settings.ts";
import type { ContentBlock } from "../core/types.ts";

function blockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") return `${block.name}\n${JSON.stringify(block.input, null, 2)}`;
  if (block.type === "tool_result") return block.content;
  return `[${block.type} omitted]`;
}
export function sharedSession(id: string, opts: { cwd?: string; secrets?: string[]; now?: () => Date } = {}): SharedSession {
  const loaded = loadSession(validateSessionId(id), opts.cwd);
  const secrets = opts.secrets ?? configuredSecretValues(loaded.start.cwd);
  const messages = loaded.messages.filter((m) => m.visibility !== "llm_only").map((m) => ({ role: m.role, text: m.content.map((b) => blockText(redactSharedValue(b, secrets) as ContentBlock)).join("\n\n") }));
  const result = { schemaVersion: 1 as const, title: redactSharedText(loaded.start.title, secrets), exportedAt: (opts.now?.() ?? new Date()).toISOString(), messages };
  assertSharedSize(JSON.stringify(result)); return result;
}
function importPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid imported session id");
  return join(rigwellHome(), "imports", `${id}.json`);
}
function checkImportDirectory() {
  const stat = lstatSync(join(rigwellHome(), "imports"));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Imported sessions require an unlinked storage directory");
}
export function saveImportedSession(value: SharedSession) {
  const safe = parseSharedSession(JSON.stringify(value)), id = crypto.randomUUID(), file = importPath(id);
  mkdirSync(join(rigwellHome(), "imports"), { recursive: true });
  checkImportDirectory();
  writeFileSync(file, JSON.stringify(safe), { flag: "wx", mode: 0o600 });
  return { importId: id, readOnly: true, url: `rigwell://imports/${id}` };
}
export function readImportedSession(id: string) {
  const file = importPath(id); checkImportDirectory(); const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SHARE_MAX_BYTES) throw new Error("Invalid imported session file");
  return parseSharedSession(readFileSync(file, "utf8"));
}
export async function forkImportedSession(id: string, cwd: string) {
  const value = readImportedSession(id), files = createSession({ id: crypto.randomUUID(), cwd, title: `${value.title} (fork)`, extra: { importedFrom: id } });
  let parent: string | null = null;
  for (const m of value.messages) {
    const messageId = crypto.randomUUID();
    await appendMessage(files, { id: messageId, role: m.role, content: [{ type: "text", text: m.text }] }, parent); parent = messageId;
  }
  writeSessionSettings(files, { autonomyLevel: "off", tags: [{ name: "imported-session" }] });
  return { sessionId: files.id, cwd };
}
