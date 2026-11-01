// Side-chat fork storage (spec 17.4, 12.1): a fork is a hidden session stored in `<sessions>/btw/<id>.jsonl` with
// `<id>.settings.json`, tagged `btw-fork`. Promote removes the tag and moves both files into the project's session
// folder, which makes it a normal session. Only the storage helpers are used; nothing here edits src/storage.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "../core/types.ts";
import type { SessionPersistence } from "../agent/session.ts";
import { hostId, projectSessionsDir, sessionsDir, validateSessionId } from "../storage/paths.ts";
import { readSessionSettings, updateSessionSettings, writeSessionSettings } from "../storage/session-settings.ts";
import { appendMessage, appendTitle, appendTurnOutcome, filesFor, type SessionFiles } from "../storage/transcript.ts";

export const BTW_TAG = "btw-fork";

export interface PriorExchange { question: string; answer: string }

export const btwDir = () => path.join(sessionsDir(), "btw");

/** True when a settings object carries the btw-fork tag. */
export function hasBtwTag(settings: { tags?: { name: string }[] } | null | undefined): boolean {
  return !!settings?.tags?.some((t) => t?.name === BTW_TAG);
}

/** Writes the fork's session_start, settings (tag + prior exchanges) and the copied main conversation. */
export async function openBtwFork(o: { id: string; mainId: string; cwd: string; messages: Message[]; priorExchanges: PriorExchange[] }): Promise<{ files: SessionFiles; persistence: SessionPersistence }> {
  const dir = btwDir();
  mkdirSync(dir, { recursive: true });
  const files = filesFor(dir, o.id);
  const start = { type: "session_start", id: o.id, title: "Side chat", version: 2, cwd: o.cwd, hostId: hostId(), parent: o.mainId };
  writeFileSync(files.transcriptPath, JSON.stringify(start) + "\n", { flag: "wx" });
  writeSessionSettings(files, {
    title: "Side chat",
    tags: [{ name: BTW_TAG, metadata: { parent: o.mainId, priorExchanges: o.priorExchanges.slice(-10) } }],
  });
  let parent: string | null = null;
  for (const m of o.messages) { await appendMessage(files, m, parent); parent = m.id; }
  const persistence: SessionPersistence = {
    appendMessage: async (msg, parentId) => { await appendMessage(files, msg, parentId); },
    appendTurnOutcome: (r) => appendTurnOutcome(files, r),
    setTitle: async (title, manual) => { await appendTitle(files, title, manual); updateSessionSettings(files, { title, isSessionTitleManuallySet: manual }); },
    saveSettings: async (patch) => { updateSessionSettings(files, patch); },
  };
  return { files, persistence };
}

/**
 * Promote: removes the btw-fork tag and moves the fork into the project's session folder. Returns the new files.
 * The caller makes sure the fork is not running.
 */
export async function promoteBtwFork(forkId: string, cwd: string, title: string): Promise<SessionFiles> {
  validateSessionId(forkId);
  const from = filesFor(btwDir(), forkId);
  if (!existsSync(from.transcriptPath)) throw new Error("This side chat is not stored (nothing to promote).");
  const destDir = projectSessionsDir(cwd);
  mkdirSync(destDir, { recursive: true });
  const to = filesFor(destDir, forkId);
  if (existsSync(to.transcriptPath)) throw new Error("A session with this id already exists.");
  const settings = readSessionSettings(from) ?? {};
  const tags = (settings.tags ?? []).filter((t) => t.name !== BTW_TAG);
  renameSync(from.transcriptPath, to.transcriptPath);
  if (existsSync(from.settingsPath)) renameSync(from.settingsPath, to.settingsPath);
  rmSync(from.settingsPath + ".bak", { force: true });
  rmSync(from.lockPath, { force: true });
  const next = { ...settings, title, isSessionTitleManuallySet: true } as Record<string, unknown>;
  if (tags.length) next.tags = tags; else delete next.tags;
  writeSessionSettings(to, next);
  await appendTitle(to, title, true);
  return to;
}

/** Fork ids currently stored (tests, cleanup). */
export function listBtwForkIds(): string[] {
  try { return readdirSync(btwDir()).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)); } catch { return []; }
}
