// Mission folder: files, schemas and the append-only logs (spec §15.2, §15.5, §15.6).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rigwellHome } from "../storage/paths.ts";

export type MissionState = "planning" | "awaiting_input" | "initializing" | "running" | "orchestrator_turn" | "completed" | "paused";
export type FeatureStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Feature {
  id: string;
  description: string;
  skillName: string;
  preconditions?: string[];
  expectedBehavior?: string[];
  fulfills?: string[];
  milestone: string;
  status: FeatureStatus;
  workerSessionIds?: string[];
  currentWorkerSessionId?: string;
  completedWorkerSessionId?: string;
}

export interface StateFile {
  missionId: string;
  state: MissionState;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  lastReviewedHandoffCount: number;
  initialFeatureCount: number;
  featureRetryBudgetBonus: Record<string, number>;
  /** Why the mission is paused (extra field; absent otherwise). */
  pauseReason?: string;
  /** Set once the scope-growth pause has fired. */
  scopeGrowthPaused?: boolean;
}

export interface Handoff {
  salientSummary: string;
  whatWasImplemented: string;
  whatWasLeftUndone: string;
  verification: { commandsRun: { command: string; exitCode: number; observation: string }[]; interactiveChecks?: { action: string; observed: string }[] };
  tests: { added: { file: string; cases: { name: string; verifies: string }[] }[]; updated?: unknown[]; coverage: string };
  discoveredIssues: { severity: "blocking" | "non_blocking" | "suggestion"; description: string; suggestedFix?: string }[];
  skillFeedback?: unknown;
}

export interface HandoffRecord {
  timestamp: string;
  workerSessionId: string;
  featureId: string;
  milestone: string;
  commitId?: string;
  repoPath?: string;
  successState: "success" | "partial" | "failure";
  returnToOrchestrator: boolean;
  handoff: Handoff;
}

export const VALIDATOR_SKILLS = ["scrutiny-validator", "user-testing-validator"];
export const isValidatorSkill = (s: string) => VALIDATOR_SKILLS.includes(s);
export const PROTECTED_MISSION_FILES = ["state.json", "progress_log.jsonl", "model-settings.json"];

export const missionsRoot = () => join(rigwellHome(), "missions");
export const missionDirFor = (orchestratorSessionId: string) => join(missionsRoot(), orchestratorSessionId);

const FEATURE_EXAMPLE = `{"features":[{"id":"api-1","description":"Add the /health endpoint","skillName":"backend-worker","milestone":"m1","status":"pending","preconditions":[],"expectedBehavior":["GET /health returns 200"],"fulfills":["A1"]}]}`;

/** Returns an error message (with an example of the right shape) or null when the content is valid. */
export function checkFeaturesJson(text: string): string | null {
  const bad = (m: string) => `features.json is invalid: ${m}. Example of the right shape: ${FEATURE_EXAMPLE}`;
  let j: any;
  try { j = JSON.parse(text); } catch (e) { return bad(`not valid JSON (${(e as Error).message})`); }
  if (!j || typeof j !== "object" || !Array.isArray(j.features)) return bad('top level must be an object with a "features" array');
  const seen = new Set<string>();
  for (const [i, f] of j.features.entries()) {
    if (!f || typeof f !== "object") return bad(`features[${i}] must be an object`);
    for (const k of ["id", "description", "skillName", "milestone"]) if (typeof f[k] !== "string" || !f[k].trim()) return bad(`features[${i}].${k} must be a non-empty string`);
    if (!["pending", "in_progress", "completed", "cancelled"].includes(f.status)) return bad(`features[${i}].status must be pending, in_progress, completed or cancelled`);
    for (const k of ["preconditions", "expectedBehavior", "fulfills", "workerSessionIds"]) {
      if (f[k] !== undefined && (!Array.isArray(f[k]) || f[k].some((x: unknown) => typeof x !== "string"))) return bad(`features[${i}].${k} must be an array of strings`);
    }
    if (seen.has(f.id)) return bad(`duplicate feature id ${f.id}`);
    seen.add(f.id);
  }
  return null;
}

export function checkValidationState(text: string): string | null {
  const ex = `{"assertions":{"A1":{"status":"pending"}}}`;
  let j: any;
  try { j = JSON.parse(text); } catch (e) { return `validation-state.json is invalid: not valid JSON (${(e as Error).message}). Example: ${ex}`; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return `validation-state.json is invalid: must be a JSON object. Example: ${ex}`;
  if (j.assertions !== undefined) {
    if (!j.assertions || typeof j.assertions !== "object" || Array.isArray(j.assertions)) return `validation-state.json is invalid: "assertions" must be an object. Example: ${ex}`;
    for (const [k, v] of Object.entries<any>(j.assertions)) {
      if (!v || typeof v !== "object" || !["pending", "passed", "failed", "blocked"].includes(v.status)) return `validation-state.json is invalid: assertions.${k}.status must be pending, passed, failed or blocked. Example: ${ex}`;
    }
  }
  return null;
}

const HANDOFF_EXAMPLE = `{"salientSummary":"Added /health.","whatWasImplemented":"Added the /health endpoint and a test.","whatWasLeftUndone":"","verification":{"commandsRun":[{"command":"bun test","exitCode":0,"observation":"all pass"}]},"tests":{"added":[{"file":"health.test.ts","cases":[{"name":"returns 200","verifies":"A1"}]}],"coverage":"endpoint covered"},"discoveredIssues":[]}`;

/** Validates the EndFeatureRun handoff field; returns an error with an example, or the handoff. */
export function checkHandoff(h: any): { error: string } | { handoff: Handoff } {
  const bad = (m: string) => ({ error: `handoff is invalid: ${m}. Example: ${HANDOFF_EXAMPLE}` });
  if (!h || typeof h !== "object") return bad("handoff must be an object");
  if (typeof h.salientSummary !== "string" || !h.salientSummary.trim()) return bad("salientSummary must be a non-empty string");
  if (typeof h.whatWasImplemented !== "string" || h.whatWasImplemented.trim().length < 10) return bad("whatWasImplemented must be a string of at least 10 characters");
  if (typeof h.whatWasLeftUndone !== "string") return bad("whatWasLeftUndone must be a string (empty when nothing is left)");
  const cr = h.verification?.commandsRun;
  if (!Array.isArray(cr) || cr.some((c: any) => typeof c?.command !== "string" || typeof c?.exitCode !== "number" || typeof c?.observation !== "string")) return bad("verification.commandsRun must be an array of {command, exitCode, observation}");
  if (!h.tests || !Array.isArray(h.tests.added) || typeof h.tests.coverage !== "string") return bad("tests must be {added: [...], coverage: string}");
  if (!Array.isArray(h.discoveredIssues) || h.discoveredIssues.some((d: any) => !["blocking", "non_blocking", "suggestion"].includes(d?.severity) || typeof d?.description !== "string")) return bad("discoveredIssues must be an array of {severity: blocking|non_blocking|suggestion, description}");
  return { handoff: h as Handoff };
}

export const hasUndoneWork = (h: Handoff) => { const t = h.whatWasLeftUndone.trim(); return !!t && !/^(none|n\/a|nothing)\.?$/i.test(t); };
export const needsAttention = (r: HandoffRecord) =>
  r.returnToOrchestrator || r.successState !== "success" || r.handoff.discoveredIssues.length > 0 || hasUndoneWork(r.handoff);

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(tmp, text); renameSync(tmp, file); } finally { rmSync(tmp, { force: true }); }
}

export interface StoreEvents {
  state?(s: StateFile): void;
  features?(f: Feature[]): void;
  log?(entry: Record<string, unknown>): void;
}

export class MissionStore {
  constructor(readonly dir: string, private ev: StoreEvents = {}) {}
  setEvents(ev: StoreEvents) { this.ev = ev; }
  path(...p: string[]) { return join(this.dir, ...p); }
  exists() { return existsSync(this.dir); }
  ensure() { mkdirSync(this.path("handoffs"), { recursive: true }); mkdirSync(this.path("skills"), { recursive: true }); }

  readState(): StateFile | null {
    try { return JSON.parse(readFileSync(this.path("state.json"), "utf8")); } catch { return null; }
  }
  /** A missing state.json reads as planning. */
  stateName(): MissionState { return this.readState()?.state ?? "planning"; }
  writeState(patch: Partial<StateFile>): StateFile {
    const cur = this.readState();
    const now = new Date().toISOString();
    const next = { missionId: "mis_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8), state: "planning", workingDirectory: "", createdAt: now, lastReviewedHandoffCount: 0, initialFeatureCount: 0, featureRetryBudgetBonus: {}, ...(cur ?? {}), ...patch, updatedAt: now } as StateFile;
    if (next.state !== "paused" || next.pauseReason === undefined) delete next.pauseReason;
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.path("state.json"), JSON.stringify(next, null, 2) + "\n");
    this.ev.state?.(next);
    return next;
  }
  setState(state: MissionState, pauseReason?: string) { return this.writeState({ state, pauseReason }); }

  features(): Feature[] {
    try { const j = JSON.parse(readFileSync(this.path("features.json"), "utf8")); return Array.isArray(j.features) ? j.features : []; } catch { return []; }
  }
  /** System write (the runner): bypasses the orchestrator-only rule. */
  writeFeatures(f: Feature[]) {
    atomicWrite(this.path("features.json"), JSON.stringify({ features: f }, null, 2) + "\n");
    this.ev.features?.(f);
  }
  updateFeature(id: string, fn: (f: Feature) => void): Feature | undefined {
    const all = this.features();
    const f = all.find((x) => x.id === id);
    if (!f) return undefined;
    fn(f);
    this.writeFeatures(all);
    return f;
  }

  log(type: string, data: Record<string, unknown> = {}) {
    const entry = { timestamp: new Date().toISOString(), type, ...data };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path("progress_log.jsonl"), JSON.stringify(entry) + "\n");
    this.ev.log?.(entry);
    return entry;
  }
  readLog(): Record<string, any>[] {
    try { return readFileSync(this.path("progress_log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  handoffs(): HandoffRecord[] {
    try { return readFileSync(this.path("handoffs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }
  addHandoff(r: HandoffRecord) {
    mkdirSync(this.path("handoffs"), { recursive: true });
    appendFileSync(this.path("handoffs.jsonl"), JSON.stringify(r) + "\n");
    const stamp = r.timestamp.replace(/[:.]/g, "-");
    writeFileSync(this.path("handoffs", `${stamp}__${r.featureId}__${r.workerSessionId}.json`), JSON.stringify(r, null, 2) + "\n");
  }
  handoffFor(workerSessionId: string): HandoffRecord | undefined {
    return this.handoffs().filter((h) => h.workerSessionId === workerSessionId).at(-1);
  }
  addWorkerTranscript(entry: Record<string, unknown>) {
    appendFileSync(this.path("worker-transcripts.jsonl"), JSON.stringify(entry) + "\n");
  }

  /** mtime (ms) of a mission file, 0 when missing. */
  mtime(name: string): number { try { return statSync(this.path(name)).mtimeMs; } catch { return 0; } }
  listSkillDirs(): string[] { try { return readdirSync(this.path("skills")); } catch { return []; } }
}
