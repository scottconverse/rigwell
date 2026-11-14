// Eval loop types (spec section 8).
import type { ReasoningEffort } from "../core/types.ts";

/** Prices in USD per million tokens. Cached input is the cache-read price; cacheWrite defaults to the input price. */
export interface Price {
  inputPerMtok: number;
  cachedInputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok?: number;
}

/**
 * A harness variant under test (a "proposal" in spec section 8). It is applied through the public surface only:
 * `settings` is written to a per-run settings file passed as `--settings` (runtime level), and
 * `toolExecutionMode` goes to initialize_session. Prompt-variant or tool-description overrides are expressed
 * as settings keys once the profile layer reads them; this runner just carries them.
 */
export interface Variant {
  name: string;
  hypothesis?: string;
  settings?: Record<string, unknown>;
  toolExecutionMode?: "direct_only" | "script_only";
}

export interface ModelSpec {
  /** Model id as the harness knows it, e.g. custom:My-Model-0. */
  id: string;
  /** Family used to group models in experiments; defaults to the id. */
  family?: string;
  prices?: Price;
  /** Explicit run-scoped effort for comparisons; does not change saved profile defaults. */
  reasoningEffort?: ReasoningEffort;
}

export interface EvalConfig {
  models: ModelSpec[];
  /** Explicitly configured external headless CLI; real accounts are used only for hand-run quality checks. */
  comparison?: ExternalHarness;
  variants?: Variant[];
  autonomy?: "low" | "medium" | "high";
  trials?: number;
  /** Per-trial wall-clock cap in ms (a task's own budget wins). */
  timeoutMs?: number;
  /** Directory of task folders; default eval/tasks in the Rigwell checkout. */
  tasksDir?: string;
}

export interface ExternalHarness {
  id: string;
  /** Executable plus optional interpreter/script arguments; common exec protocol flags are appended. */
  command: string[];
  /** Per-process external settings; never rewrites the external application's user profile. */
  settingsPath?: string;
  /** Canonical Rigwell profile id to the equivalent profile id in the external CLI. */
  modelMap: Record<string, string>;
  methodPrefix: string;
  envelope?: Record<string, unknown>;
  versionArgs?: string[];
}

export interface TaskBudget {
  timeoutMs?: number;
  maxRequests?: number;
  maxCostUsd?: number;
}

export interface TaskDef {
  name: string;
  category?: "bug-fix" | "feature" | "refactor" | "tests" | "terminal" | "multi-file";
  dir: string;
  /** The starting repo, copied for each trial. */
  fixtureDir: string;
  prompt: string;
  /** Shell command run in the working copy after the session; exit 0 passes. $EVAL_TASK_DIR points at the task folder. */
  grader: string;
  budget: TaskBudget;
}

export interface TokenCounts { input: number; cacheRead: number; cacheCreation: number; output: number }

export type FailKind = "none" | "grader" | "budget" | "timeout" | "session";

export interface TrialResult {
  task: string;
  model: string;
  family: string;
  variant: string;
  trial: number;
  passed: boolean;
  failKind: FailKind;
  graderDetail: string;
  turnReason: string;
  wallMs: number;
  requests: number;
  tokens: TokenCounts;
  costUsd: number;
  priced: boolean;
  cacheHitRate: number;
  reasoningEffort?: ReasoningEffort;
}

export interface RunRecord {
  schema: 1;
  buildId: string;
  startedAt: string;
  finishedAt: string;
  autonomy: string;
  trials: number;
  results: TrialResult[];
  harness?: { id: string; version: string };
}
