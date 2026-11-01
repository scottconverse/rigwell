// fork_session (spec 3.1.5, 12.1 `parent`): copies a session's transcript into a new session and records the source in `parent`.
import { readFileSync, writeFileSync } from "node:fs";
import { filesFor, type SessionFiles } from "./transcript.ts";
import { readSessionSettings, writeSessionSettings } from "./session-settings.ts";

export function forkSession(src: SessionFiles, o: { title?: string; tags?: { name: string; metadata?: Record<string, unknown> }[] } = {}): SessionFiles {
  const lines = readFileSync(src.transcriptPath, "utf8").split("\n").filter((l) => l.trim());
  const first = JSON.parse(lines[0]!);
  const id = crypto.randomUUID();
  const dest = filesFor(src.dir, id);
  const start = {
    ...first, id, title: o.title ?? `${first.title ?? "New Session"} (fork)`, parent: src.id,
    isSessionTitleManuallySet: o.title !== undefined ? true : undefined,
  };
  writeFileSync(dest.transcriptPath, [JSON.stringify(start), ...lines.slice(1)].join("\n") + "\n", { flag: "wx" });
  const settings = readSessionSettings(src);
  if (settings) {
    writeSessionSettings(dest, { ...settings, ...(o.tags ? { tags: [...(settings.tags ?? []), ...o.tags] } : {}) });
  }
  return dest;
}
