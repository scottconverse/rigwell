// Append-only transcript store (spec §12.1). One JSON object per line.
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ContentBlock, Message, OpenAIReasoning, ReasoningEffort } from "../core/types.ts";
import { hostId, projectSessionsDir, projectSlug, sessionsDir, validateSessionId } from "./paths.ts";

export interface SessionFiles {
  id: string;
  dir: string;
  transcriptPath: string;
  settingsPath: string;
  lockPath: string;
}

export interface SessionStart {
  type: "session_start";
  id: string;
  title: string;
  sessionTitleAutoStage?: string;
  isSessionTitleManuallySet?: boolean;
  owner?: string;
  version: 2;
  cwd: string;
  hostId: string;
  [k: string]: unknown;
}

export interface TurnOutcome {
  type: "agent_turn_outcome";
  turnId: string;
  reason: string;
  resultKind: "text" | "structured" | null;
}

export interface LoadedSession {
  start: SessionStart;
  /** Messages ordered by `seq` (file order breaks ties). */
  messages: Message[];
  outcomes: TurnOutcome[];
  files: SessionFiles;
  /** Lines that were not valid JSON objects. */
  skippedLines: number;
  /** Count of records with an unrecognised `type` (tolerated). */
  unknownRecords: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd?: string;
  projectSlug: string;
  transcriptPath: string;
  mtimeMs: number;
}

export function filesFor(dir: string, id: string): SessionFiles {
  validateSessionId(id);
  const transcriptPath = path.join(dir, `${id}.jsonl`);
  return {
    id,
    dir,
    transcriptPath,
    settingsPath: path.join(dir, `${id}.settings.json`),
    lockPath: `${transcriptPath}.events.lock`,
  };
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readFirstLine(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(65536);
    let acc = "";
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      acc += buf.toString("utf8", 0, n);
      const i = acc.indexOf("\n");
      if (i >= 0) return acc.slice(0, i);
      if (acc.length > 1 << 20) break;
    }
    return acc.length ? acc : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseStart(line: string | null): SessionStart | null {
  if (!line) return null;
  try {
    const o = JSON.parse(line);
    return o && o.type === "session_start" && typeof o.id === "string" ? (o as SessionStart) : null;
  } catch {
    return null;
  }
}

// ---------- create ----------

/**
 * Creates the project folder and writes the `session_start` line synchronously.
 * If the transcript already exists with a valid first line it is kept as is;
 * if it exists but cannot be loaded it is removed and recreated (spec §12.1).
 */
export function createSession(opts: {
  id: string;
  cwd: string;
  title?: string;
  owner?: string;
  sessionTitleAutoStage?: string;
}): SessionFiles {
  const files = filesFor(projectSessionsDir(opts.cwd), opts.id);
  mkdirSync(files.dir, { recursive: true });
  if (existsSync(files.transcriptPath)) {
    if (parseStart(readFirstLine(files.transcriptPath))) return files;
    rmSync(files.transcriptPath, { force: true });
  }
  const start: SessionStart = {
    type: "session_start",
    id: opts.id,
    title: opts.title ?? "New Session",
    ...(opts.sessionTitleAutoStage ? { sessionTitleAutoStage: opts.sessionTitleAutoStage } : {}),
    ...(opts.owner ? { owner: opts.owner } : {}),
    version: 2,
    cwd: opts.cwd,
    hostId: hostId(),
  };
  writeFileSync(files.transcriptPath, JSON.stringify(start) + "\n", { flag: "wx" });
  return files;
}

// ---------- message (de)serialisation ----------

/**
 * OpenAI reasoning mapping (documented choice): the in-memory `openaiReasoning` array maps to the
 * flat spec fields of the FIRST item: `openaiReasoningId`, `openaiEncryptedContent`,
 * `openaiReasoningSummary`. Any further items go to `openaiReasoningMore` (array of
 * {id, encryptedContent?, summary?}) so nothing is lost on a round trip.
 */
function encodeMessage(m: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content.map(encodeBlock) };
  if (m.visibility) out.visibility = m.visibility;
  if (m.modelId) out.modelId = m.modelId;
  if (m.apiProvider) out.apiProvider = m.apiProvider;
  if (m.reasoningEffort) out.reasoningEffort = m.reasoningEffort;
  const r = m.openaiReasoning;
  if (r && r.length > 0) {
    out.openaiReasoningId = r[0]!.id;
    if (r[0]!.encryptedContent !== undefined) out.openaiEncryptedContent = r[0]!.encryptedContent;
    if (r[0]!.summary !== undefined) out.openaiReasoningSummary = r[0]!.summary;
    if (r.length > 1) out.openaiReasoningMore = r.slice(1);
  }
  return out;
}

function encodeBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking": {
      const o: Record<string, unknown> = { type: "thinking", thinking: b.thinking };
      if (b.signature !== undefined) o.signature = b.signature;
      if (b.signatureProvider !== undefined) o.signatureProvider = b.signatureProvider;
      return o;
    }
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, is_error: b.is_error ?? false, content: b.content };
  }
}

function decodeBlock(b: any): ContentBlock | null {
  if (!b || typeof b !== "object") return null;
  switch (b.type) {
    case "text":
      return { type: "text", text: String(b.text ?? "") };
    case "thinking":
      return {
        type: "thinking", thinking: String(b.thinking ?? ""),
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
        ...(b.signatureProvider !== undefined ? { signatureProvider: b.signatureProvider } : {}),
      };
    case "tool_use":
      return { type: "tool_use", id: String(b.id), name: String(b.name), input: b.input ?? {} };
    case "tool_result": {
      // On disk `content` may be a string or a list of text blocks (spec §12.1).
      const c = Array.isArray(b.content)
        ? b.content.map((x: any) => (typeof x === "string" ? x : String(x?.text ?? ""))).join("")
        : String(b.content ?? "");
      return { type: "tool_result", tool_use_id: String(b.tool_use_id), content: c, ...(b.is_error !== undefined ? { is_error: !!b.is_error } : {}) };
    }
    default:
      return null; // unknown block types are dropped
  }
}

function decodeMessage(rec: any): Message | null {
  const m = rec.message;
  if (!m || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content)) return null;
  const msg: Message = {
    id: String(rec.id),
    role: m.role,
    content: m.content.map(decodeBlock).filter((x: ContentBlock | null): x is ContentBlock => x !== null),
  };
  if (m.visibility === "llm_only" || m.visibility === "user_only") msg.visibility = m.visibility;
  if (typeof m.modelId === "string") msg.modelId = m.modelId;
  if (typeof m.apiProvider === "string") msg.apiProvider = m.apiProvider;
  if (typeof m.reasoningEffort === "string") msg.reasoningEffort = m.reasoningEffort as ReasoningEffort;
  if (typeof m.openaiReasoningId === "string") {
    const items: OpenAIReasoning[] = [
      {
        id: m.openaiReasoningId,
        ...(m.openaiEncryptedContent !== undefined ? { encryptedContent: m.openaiEncryptedContent } : {}),
        ...(m.openaiReasoningSummary !== undefined ? { summary: m.openaiReasoningSummary } : {}),
      },
    ];
    if (Array.isArray(m.openaiReasoningMore)) items.push(...m.openaiReasoningMore);
    msg.openaiReasoning = items;
  }
  return msg;
}

// ---------- locked append ----------

const queues = new Map<string, Promise<unknown>>();
const seqCache = new Map<string, { size: number; next: number }>();
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquireLock(lockPath: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { force: true }); // steal stale lock
          continue;
        }
      } catch {
        continue; // vanished between calls
      }
      if (Date.now() - t0 > LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for ${lockPath}`);
      await sleep(2 + Math.random() * 6);
    }
  }
}

function scanNextSeq(file: string): number {
  let max = -1;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type === "message" && typeof o.seq === "number" && o.seq > max) max = o.seq;
    } catch {
      /* ignore */
    }
  }
  return max + 1;
}

/** Serialises per file in-process (promise queue) and across processes (.events.lock). */
async function withAppendLock<T>(files: SessionFiles, fn: () => T): Promise<T> {
  const key = files.transcriptPath;
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    await acquireLock(files.lockPath);
    try {
      return fn();
    } finally {
      rmSync(files.lockPath, { force: true });
    }
  });
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

function appendLine(files: SessionFiles, rec: Record<string, unknown>) {
  appendFileSync(files.transcriptPath, JSON.stringify(rec) + "\n");
}

/** Appends a `message` record. `seq` is per file, starting at 0, +1 per message. Returns the seq. */
export function appendMessage(files: SessionFiles, msg: Message, parentId: string | null): Promise<number> {
  return withAppendLock(files, () => {
    const file = files.transcriptPath;
    const size = statSync(file).size;
    const c = seqCache.get(file);
    const seq = c && c.size === size ? c.next : scanNextSeq(file);
    appendLine(files, {
      type: "message",
      id: msg.id,
      parentId,
      timestamp: new Date().toISOString(),
      seq,
      message: encodeMessage(msg),
    });
    seqCache.set(file, { size: statSync(file).size, next: seq + 1 });
    return seq;
  });
}

export function appendTurnOutcome(
  files: SessionFiles,
  o: { turnId: string; reason: string; resultKind: "text" | "structured" | null },
): Promise<void> {
  return withAppendLock(files, () => {
    appendLine(files, { type: "agent_turn_outcome", turnId: o.turnId, reason: o.reason, resultKind: o.resultKind });
  });
}

// ---------- find / load / list ----------

/** Looks in cwd's slug folder, then every project folder, then the sessions root (old layout). */
export function findSession(id: string, cwd?: string): SessionFiles | null {
  validateSessionId(id);
  const root = sessionsDir();
  const dirs: string[] = [];
  if (cwd) dirs.push(projectSessionsDir(cwd));
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(root, e.name));
    }
  } catch {
    /* no sessions yet */
  }
  dirs.push(root);
  for (const d of dirs) {
    const f = filesFor(d, id);
    if (!isInside(root, f.transcriptPath)) continue;
    if (existsSync(f.transcriptPath)) return f;
  }
  return null;
}

export function loadSession(id: string, cwd?: string): LoadedSession {
  const files = findSession(id, cwd);
  if (!files) throw new Error(`session not found: ${id}`);
  return loadTranscript(files);
}

export function loadTranscript(files: SessionFiles): LoadedSession {
  const lines = readFileSync(files.transcriptPath, "utf8").split("\n");
  let start: SessionStart | null = null;
  const msgs: { msg: Message; seq: number; order: number }[] = [];
  const outcomes: TurnOutcome[] = [];
  let skippedLines = 0;
  let unknownRecords = 0;
  let first = true;
  lines.forEach((line, order) => {
    if (!line.trim()) return;
    let o: any;
    try {
      o = JSON.parse(line);
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not an object");
    } catch {
      if (first) throw new Error(`transcript ${files.transcriptPath}: first line is not valid JSON`);
      skippedLines++;
      return;
    }
    if (first) {
      first = false;
      if (o.type !== "session_start") throw new Error(`transcript ${files.transcriptPath}: first record must be session_start`);
      start = o as SessionStart;
      return;
    }
    if (o.type === "message") {
      const m = decodeMessage(o);
      if (m) msgs.push({ msg: m, seq: typeof o.seq === "number" ? o.seq : Number.MAX_SAFE_INTEGER, order });
      else skippedLines++;
    } else if (o.type === "agent_turn_outcome") {
      outcomes.push({ type: "agent_turn_outcome", turnId: o.turnId, reason: o.reason, resultKind: o.resultKind ?? null });
    } else if (o.type !== "session_start") {
      unknownRecords++;
    }
  });
  if (!start) throw new Error(`transcript ${files.transcriptPath}: empty`);
  msgs.sort((a, b) => a.seq - b.seq || a.order - b.order);
  return { start, messages: msgs.map((x) => x.msg), outcomes, files, skippedLines, unknownRecords };
}

/** Newest-first (mtime) scan; no index. With `cwd`, only that project's folder. */
export function listSessions(cwd?: string): SessionSummary[] {
  const root = sessionsDir();
  const dirs: string[] = cwd
    ? [projectSessionsDir(cwd)]
    : (() => {
        try {
          return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
        } catch {
          return [];
        }
      })();
  const out: SessionSummary[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = path.join(d, n);
      try {
        const start = parseStart(readFirstLine(p));
        if (!start) continue;
        out.push({
          id: start.id, title: start.title ?? "New Session", cwd: start.cwd,
          projectSlug: path.basename(d), transcriptPath: p, mtimeMs: statSync(p).mtimeMs,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export { projectSlug };
