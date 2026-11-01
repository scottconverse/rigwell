// Automation folders on disk (spec §16.1). Layout: <root>/<folder>/{HEARTBEAT.md, memory/, reports/, secrets.json}.
// Roots: $RIGWELL_HOME/automations and <project>/.rigwell/automations (project wins on an id clash).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rigwellHome } from "../storage/paths.ts";
import { ScheduleError, machineTimeZone, normalizeSchedule, parseSchedule, validTimeZone, type Schedule } from "./schedule.ts";

export type RunStatus = "in_progress" | "success" | "failure" | "cancelled";
export type FailureReason =
  | "dispatch_timed_out" | "automation_files_missing" | "host_resources" | "dispatch_exception" | "agent_error"
  | "model_timed_out" | "mcp_unavailable" | "host_slept" | "daemon_restarted" | "session_closed_by_user" | "closed_before_completion";
export type TriggerKind = "schedule" | "webhook" | "manual";

export interface Frontmatter {
  name: string;
  schedule?: string;
  description?: string;
  model?: string;
  reasoningEffort?: string;
  workingDirectory?: string;
  paused?: boolean;
  tags?: string[];
  targetSessionId?: string;
  trigger?: "schedule" | "webhook";
  /** IANA zone the cron is evaluated in. Default: the machine zone at creation. */
  timezone?: string;
  /** off | low | medium | high. Default high. Never skip-all-permissions. */
  autonomy?: string;
  payloadRegex?: string;
  maxRunsPerHour?: number;
}

export interface AutomationState {
  id: string;
  createdAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  lastRunSessionId?: string;
  lastRunStatus?: RunStatus;
  runCount: number;
  health?: "degraded";
  /** Final failures (retry included) in a row; reset by a success or a resume. */
  consecutiveFailures?: number;
  /** Set when the automation paused itself (spec 16.3 auto-pause). */
  pausedReason?: "missed_runs" | "consecutive_failures";
  pausedAt?: number;
  /** When the user last resumed it; the missed-run clock restarts here. */
  resumedAt?: number;
  /** A failed first attempt waits here for its one retry. */
  retry?: { at: number; trigger: TriggerKind; payload?: string; scheduledFor?: number };
}

export interface RunRecord {
  runId: string;
  sessionId?: string;
  status: RunStatus;
  trigger: TriggerKind;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  failureReason?: FailureReason;
  errorMessage?: string;
  hadAssistantResponse?: boolean;
  modelFallback?: { requested: string; used: string; reason: string };
  catchUp?: boolean;
  scheduledFor?: number;
  missedSlots?: number;
  mcpUnavailable?: boolean;
  reportFile?: string;
}

export interface Automation {
  folder: string;
  dir: string;
  isValid: boolean;
  invalidReason?: "missing_file" | "invalid_frontmatter" | "invalid_schedule" | "parse_error";
  error?: string;
  broken?: boolean;
  id: string;
  fm: Frontmatter;
  body: string;
  schedule?: Schedule;
  timezone: string;
  state: AutomationState;
  source: "home" | "project";
}

export const automationsRoot = () => join(rigwellHome(), "automations");
export const projectAutomationsRoot = (project: string) => join(resolve(project), ".rigwell", "automations");

export function atomicWrite(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- frontmatter (a small YAML subset: scalars, booleans, numbers, [a, b] lists) ----
function scalar(v: string): unknown {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((x) => String(scalar(x))).filter((x) => x !== "");
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    try { return t.startsWith('"') ? JSON.parse(t) : t.slice(1, -1); } catch { return t.slice(1, -1); }
  }
  return t;
}

export function parseHeartbeat(text: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) throw new Error("HEARTBEAT.md must start with a --- frontmatter block");
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`bad frontmatter line: ${line}`);
    fm[line.slice(0, i).trim()] = scalar(line.slice(i + 1));
  }
  return { fm, body: (m[2] ?? "").replace(/^\r?\n/, "") };
}


export function serializeHeartbeat(fm: Frontmatter, body: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else if (typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${String(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\n+/, "")}${body.endsWith("\n") ? "" : "\n"}`;
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}

const AUTONOMY = ["off", "low", "medium", "high"];

/** Validates frontmatter fields shared by create and update. Throws ScheduleError / Error with a clear message. */
export function validateFrontmatter(fm: Frontmatter): Schedule | undefined {
  if (typeof fm.name !== "string" || !fm.name.trim()) throw new Error("name is required");
  if (fm.trigger !== undefined && fm.trigger !== "schedule" && fm.trigger !== "webhook") throw new Error("trigger must be schedule or webhook");
  if (fm.timezone !== undefined && !validTimeZone(fm.timezone)) throw new Error(`unknown time zone: ${fm.timezone}`);
  if (fm.autonomy !== undefined && !AUTONOMY.includes(fm.autonomy)) throw new Error("autonomy must be off, low, medium or high");
  if (fm.payloadRegex !== undefined) { try { new RegExp(fm.payloadRegex); } catch { throw new Error("payloadRegex is not a valid regular expression"); } }
  if (fm.maxRunsPerHour !== undefined && (!Number.isInteger(fm.maxRunsPerHour) || fm.maxRunsPerHour < 1)) throw new Error("maxRunsPerHour must be a positive integer");
  if (fm.trigger === "webhook" && !fm.schedule) return undefined;
  if (typeof fm.schedule !== "string") throw new ScheduleError("schedule is required");
  return parseSchedule(fm.schedule);
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "automation";
}

export function scanRoot(root: string, source: "home" | "project"): Automation[] {
  if (!existsSync(root)) return [];
  const out: Automation[] = [];
  for (const folder of readdirSync(root).sort()) {
    const dir = join(root, folder);
    let st;
    try { st = lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue; // symlinked folders are refused
    out.push(loadAutomation(dir, folder, source));
  }
  return out;
}

export function loadAutomation(dir: string, folder: string, source: "home" | "project"): Automation {
  const stateFile = join(dir, "memory", "state.json");
  const base: Automation = {
    folder, dir, isValid: false, id: folder, fm: { name: folder }, body: "", timezone: "UTC", source,
    state: { id: folder, createdAt: 0, runCount: 0 },
  };
  const hb = join(dir, "HEARTBEAT.md");
  if (!existsSync(hb)) return { ...base, invalidReason: "missing_file", error: "HEARTBEAT.md not found" };
  let parsed;
  try { parsed = parseHeartbeat(readFileSync(hb, "utf8")); } catch (e) { return { ...base, invalidReason: "parse_error", error: (e as Error).message }; }
  const fm = parsed.fm as unknown as Frontmatter;
  base.fm = fm; base.body = parsed.body;

  // State: the UUID in state.json wins. An id in frontmatter moves there. Unreadable state is "broken", never re-minted.
  let state = existsSync(stateFile) ? readJson<AutomationState>(stateFile) : undefined;
  if (existsSync(stateFile) && !state?.id) return { ...base, invalidReason: "parse_error", error: "memory/state.json is unreadable", broken: true };
  if (!state) {
    const fmId = (parsed.fm as Record<string, unknown>).id;
    state = { id: typeof fmId === "string" && fmId ? fmId : randomUUID(), createdAt: safeCreatedAt(dir), runCount: 0 };
    mkdirSync(join(dir, "memory"), { recursive: true });
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
  }
  base.state = state; base.id = state.id;
  if ((parsed.fm as Record<string, unknown>).id !== undefined) {
    delete (parsed.fm as Record<string, unknown>).id;
    atomicWrite(hb, serializeHeartbeat(fm, parsed.body));
  }
  try {
    if (typeof fm.name !== "string" || !fm.name.trim()) return { ...base, invalidReason: "invalid_frontmatter", error: "name is required" };
    base.timezone = fm.timezone && validTimeZone(fm.timezone) ? fm.timezone : machineTimeZone();
    const schedule = validateFrontmatter(fm);
    return { ...base, schedule, isValid: true };
  } catch (e) {
    return { ...base, invalidReason: e instanceof ScheduleError ? "invalid_schedule" : "invalid_frontmatter", error: (e as Error).message };
  }
}

function safeCreatedAt(dir: string): number {
  try { return statSync(dir).birthtimeMs || statSync(dir).mtimeMs; } catch { return Date.now(); }
}

export function writeState(a: Automation, patch: Partial<AutomationState>) {
  // Merge into what is on disk so concurrent writers (a run finishing, a pause) do not clobber each other.
  const disk = readJson<AutomationState>(join(a.dir, "memory", "state.json"));
  const next = { ...(disk ?? a.state), ...patch } as AutomationState;
  for (const k of Object.keys(patch) as (keyof AutomationState)[]) if (patch[k] === undefined) delete next[k];
  a.state = next;
  mkdirSync(join(a.dir, "memory"), { recursive: true });
  atomicWrite(join(a.dir, "memory", "state.json"), JSON.stringify(next, null, 2));
}

export function readRuns(a: Automation): RunRecord[] {
  return readJson<RunRecord[]>(join(a.dir, "memory", "runs.json")) ?? [];
}

/** Inserts or replaces a record by runId; keeps the last 50. */
export function saveRun(a: Automation, rec: RunRecord) {
  const runs = readRuns(a);
  const i = runs.findIndex((r) => r.runId === rec.runId);
  if (i >= 0) runs[i] = rec; else runs.push(rec);
  mkdirSync(join(a.dir, "memory"), { recursive: true });
  atomicWrite(join(a.dir, "memory", "runs.json"), JSON.stringify(runs.slice(-50), null, 2));
}

export interface Secrets { webhookSecret?: string; [k: string]: unknown }
export function readSecrets(a: Automation): Secrets { return readJson<Secrets>(join(a.dir, "secrets.json")) ?? {}; }
export function writeSecrets(a: Automation, s: Secrets) { atomicWrite(join(a.dir, "secrets.json"), JSON.stringify(s, null, 2)); }
export const newSecret = () => randomBytes(24).toString("hex");

/** Natural-language schedules are turned into cron once, at save time (spec 16.2). */
function withSavedSchedule(fm: Frontmatter): Frontmatter {
  return typeof fm.schedule === "string" ? { ...fm, schedule: normalizeSchedule(fm.schedule) } : fm;
}

export function createAutomationFolder(root: string, fmIn: Frontmatter, body: string, source: "home" | "project"): Automation {
  validateFrontmatter(fmIn);
  const fm = withSavedSchedule(fmIn);
  mkdirSync(root, { recursive: true });
  let folder = slugify(fm.name), n = 1;
  while (existsSync(join(root, folder))) folder = `${slugify(fm.name)}-${++n}`;
  const dir = join(root, folder);
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "reports"), { recursive: true });
  atomicWrite(join(dir, "HEARTBEAT.md"), serializeHeartbeat(fm, body));
  const a = loadAutomation(dir, folder, source);
  writeState(a, { createdAt: Date.now() });
  if (fm.trigger === "webhook") writeSecrets(a, { webhookSecret: newSecret() });
  return a;
}

export function updateAutomationFolder(a: Automation, fmPatch: Partial<Frontmatter>, body?: string) {
  const fm = { ...a.fm, ...fmPatch } as Frontmatter;
  for (const k of Object.keys(fm) as (keyof Frontmatter)[]) if (fm[k] === undefined || fm[k] === null) delete fm[k];
  validateFrontmatter(fm);
  atomicWrite(join(a.dir, "HEARTBEAT.md"), serializeHeartbeat(withSavedSchedule(fm), body ?? a.body));
}

export function deleteAutomationFolder(a: Automation) { rmSync(a.dir, { recursive: true, force: true }); }
