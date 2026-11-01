// `<sessionId>.settings.json` (spec §12.1): atomic write, `.bak` fallback, unknown fields pass through.
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AutonomyLevel, InteractionMode, ReasoningEffort, TokenUsage } from "../core/types.ts";
import type { SessionFiles } from "./transcript.ts";

export interface SessionSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  interactionMode?: InteractionMode;
  autonomyLevel?: AutonomyLevel;
  compactionThresholdCheckEnabled?: boolean;
  toolExecutionMode?: "direct_only";
  assistantActiveTimeMs?: number;
  tokenUsage?: TokenUsage;
  inclusiveTokenUsage?: TokenUsage;
  lastCallTokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  providerLock?: string;
  providerLockTimestamp?: string;
  apiProviderLock?: string;
  tags?: { name: string; metadata?: Record<string, unknown> }[];
  [k: string]: unknown;
}

function tryRead(file: string): SessionSettings | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as SessionSettings) : null;
  } catch {
    return null;
  }
}

/** Reads the settings; on a missing/corrupt main file falls back to `.bak`. Null when neither is usable. */
export function readSessionSettings(files: Pick<SessionFiles, "settingsPath">): SessionSettings | null {
  return tryRead(files.settingsPath) ?? tryRead(files.settingsPath + ".bak");
}

/** Replaces the file: existing -> `.bak`, write temp, rename over. */
export function writeSessionSettings(files: Pick<SessionFiles, "settingsPath">, settings: SessionSettings): void {
  const p = files.settingsPath;
  // Only back up a copy that parses, so a corrupt file never clobbers a good .bak.
  if (existsSync(p) && tryRead(p)) copyFileSync(p, p + ".bak");
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    renameSync(tmp, p);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Shallow-merges `patch` into the current settings (unknown fields preserved) and writes. */
export function updateSessionSettings(files: Pick<SessionFiles, "settingsPath">, patch: SessionSettings): SessionSettings {
  const next = { ...(readSessionSettings(files) ?? {}), ...patch };
  writeSessionSettings(files, next);
  return next;
}
