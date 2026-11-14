// Runs model x variant x task trials by driving `rigwell exec --input-format stream-jsonrpc` as a child process.
// Only the public wire surface is used (spec section 3.1): initialize_session, add_user_message, notifications.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { shellInvocation } from "../platform/shell.ts";
import { cacheHitRate, costOf } from "./cost.ts";
import type { EvalConfig, FailKind, ModelSpec, RunRecord, TaskDef, TokenCounts, TrialResult, Variant } from "./types.ts";

export const CLI_PATH = join(import.meta.dir, "../cli/main.ts");
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const GRADER_TIMEOUT_MS = 120_000;

export interface SessionOutcome {
  turnReason: string;
  requests: number;
  tokens: TokenCounts;
  killed: "none" | "budget" | "timeout";
  error?: string;
}

const zeroTokens = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

/** Runs one prompt to the end of its turn in a fresh `rigwell exec` child. Unattended: permission asks are declined. */
export async function driveSession(opts: {
  cwd: string; modelId: string; autonomy: string; prompt: string; settingsPath?: string;
  toolExecutionMode?: string; timeoutMs: number; maxRequests?: number; maxCostUsd?: number;
  price?: ModelSpec["prices"]; env?: Record<string, string>;
}): Promise<SessionOutcome> {
  const args = ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", opts.autonomy, "-m", opts.modelId, "--cwd", opts.cwd];
  if (opts.settingsPath) args.push("--settings", opts.settingsPath);
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderrP = new Response(proc.stderr as ReadableStream).text();
  const send = (m: unknown) => { try { (proc.stdin as any).write(JSON.stringify(m) + "\n"); } catch { /* child gone */ } };

  let usageEvents = 0;
  let lastUsageSig = "";
  let completed = false;
  let tokens = zeroTokens();
  let turnReason = "";
  let killed: SessionOutcome["killed"] = "none";
  let error: string | undefined;
  let n = 0;
  const pending = new Map<string, (m: any) => void>();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const id = `ev-${++n}`;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params });
    });

  const kill = (why: "budget" | "timeout") => { if (killed === "none") { killed = why; try { proc.kill(); } catch { /* gone */ } finish(); } };
  const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);

  const onLine = (line: string) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "response") return pending.get(m.id)?.(m);
    if (m.type === "request") {
      // request_permission and anything else the harness asks: decline (autonomy decides what runs unattended).
      send({ jsonrpc: "2.0", type: "response", id: m.id, result: { selectedOption: "cancel" } });
      return;
    }
    const note = m.params?.notification;
    if (!note) return;
    if (note.type === "session_token_usage_changed") {
      const u = note.tokenUsage ?? {};
      // The harness emits this after every model call and once more when the turn closes. The closing one repeats the
      // previous totals, so only an event that changes the totals counts as a request.
      const sig = JSON.stringify(u);
      if (sig !== lastUsageSig) usageEvents++;
      lastUsageSig = sig;
      tokens = { input: u.inputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheCreation: u.cacheCreationTokens ?? 0, output: u.outputTokens ?? 0 };
      if (opts.maxRequests !== undefined && usageEvents > opts.maxRequests) kill("budget");
      if (opts.maxCostUsd !== undefined && opts.price && costOf(tokens, opts.price) > opts.maxCostUsd) kill("budget");
    } else if (note.type === "agent_turn_completed") {
      turnReason = note.reason;
      const c = note.cumulativeTokenUsage;
      if (c) tokens = { input: c.inputTokens ?? 0, cacheRead: c.cacheReadTokens ?? 0, cacheCreation: c.cacheCreationTokens ?? 0, output: c.outputTokens ?? 0 };
      completed = true;
      finish();
    }
  };

  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    }
    finish(); // child exited
  })();

  try {
    const init = await Promise.race([
      request("initialize_session", { machineId: "default", cwd: opts.cwd, modelId: opts.modelId, ...(opts.toolExecutionMode ? { toolExecutionMode: opts.toolExecutionMode } : {}) }),
      done.then(() => null),
    ]);
    if (init?.error) error = `initialize_session: ${init.error.message}`;
    else if (init) {
      const added = await Promise.race([request("add_user_message", { text: opts.prompt, messageId: "eval-turn" }), done.then(() => null)]);
      if (added?.error) error = `add_user_message: ${added.error.message}`;
      else await done;
    }
  } finally {
    clearTimeout(timer);
    if (!completed && killed === "none" && !error) error = "session ended before the turn completed: " + (await Promise.race([stderrP, Bun.sleep(200).then(() => "")])).slice(-300);
    if (completed) await Promise.race([request("close_session", { reason: "other" }), Bun.sleep(2000)]);
    try { (proc.stdin as any).end(); } catch { /* ignore */ }
    const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
    if (exited === null) try { proc.kill(); } catch { /* ignore */ }
  }
  const requests = usageEvents;
  return { turnReason: turnReason || (killed !== "none" ? killed : "error"), requests, tokens, killed, error };
}

/** Runs the grader in the working copy. Exit 0 passes; the last lines of its output are the detail. */
export function runGrader(task: TaskDef, workDir: string): { passed: boolean; detail: string } {
  const command = process.platform === "win32"
    ? task.grader.replace(/\$EVAL_TASK_DIR\b/g, "%EVAL_TASK_DIR%").replace(/\$EVAL_WORK_DIR\b/g, "%EVAL_WORK_DIR%")
    : task.grader;
  const shell = shellInvocation(command);
  const r = spawnSync(shell.file, shell.args, {
    windowsVerbatimArguments: shell.windowsVerbatimArguments,
    cwd: workDir, encoding: "utf8", timeout: GRADER_TIMEOUT_MS, env: { ...process.env, EVAL_TASK_DIR: task.dir, EVAL_WORK_DIR: workDir },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(0, 2).join(" | ").slice(0, 300);
  return { passed: r.status === 0, detail: out || (r.error ? String(r.error.message) : `exit ${r.status}`) };
}

function prepareWorkDir(task: TaskDef): string {
  const dir = mkdtempSync(join(tmpdir(), `rigwell-eval-${task.name}-`));
  cpSync(task.fixtureDir, dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return dir;
}

export async function runTrial(opts: {
  task: TaskDef; model: ModelSpec; variant: Variant; trial: number; autonomy: string; timeoutMs: number; env?: Record<string, string>;
}): Promise<TrialResult> {
  const { task, model, variant } = opts;
  const work = prepareWorkDir(task);
  let settingsPath: string | undefined;
  if (variant.settings && Object.keys(variant.settings).length) {
    settingsPath = join(mkdtempSync(join(tmpdir(), "rigwell-eval-settings-")), "settings.json");
    writeFileSync(settingsPath, JSON.stringify(variant.settings));
  }
  const started = Date.now();
  let outcome: SessionOutcome;
  try {
    outcome = await driveSession({
      cwd: work, modelId: model.id, autonomy: opts.autonomy, prompt: task.prompt, settingsPath,
      toolExecutionMode: variant.toolExecutionMode, timeoutMs: task.budget.timeoutMs ?? opts.timeoutMs,
      maxRequests: task.budget.maxRequests, maxCostUsd: task.budget.maxCostUsd, price: model.prices, env: opts.env,
    });
  } catch (e) {
    outcome = { turnReason: "error", requests: 0, tokens: zeroTokens(), killed: "none", error: String((e as Error).message) };
  }
  const wallMs = Date.now() - started;
  let failKind: FailKind = "none";
  let detail = "";
  let passed = false;
  if (outcome.killed !== "none") { failKind = outcome.killed; detail = `${outcome.killed} exceeded`; }
  else if (outcome.error) { failKind = "session"; detail = outcome.error.slice(0, 300); }
  else if ((task.budget.maxRequests !== undefined && outcome.requests > task.budget.maxRequests)
    || (task.budget.maxCostUsd !== undefined && model.prices && costOf(outcome.tokens, model.prices) > task.budget.maxCostUsd)) {
    failKind = "budget"; detail = "budget exceeded";
  } else {
    const g = runGrader(task, work);
    passed = g.passed;
    detail = g.detail;
    if (!passed) failKind = "grader";
  }
  rmSync(work, { recursive: true, force: true });
  if (settingsPath) rmSync(join(settingsPath, ".."), { recursive: true, force: true });
  return {
    task: task.name, model: model.id, family: model.family ?? model.id, variant: variant.name, trial: opts.trial,
    passed, failKind, graderDetail: detail, turnReason: outcome.turnReason, wallMs, requests: outcome.requests,
    tokens: outcome.tokens, costUsd: costOf(outcome.tokens, model.prices), priced: !!model.prices, cacheHitRate: cacheHitRate(outcome.tokens),
  };
}

export async function runEval(opts: {
  config: EvalConfig; tasks: TaskDef[]; buildId: string; env?: Record<string, string>; onResult?: (r: TrialResult) => void;
}): Promise<RunRecord> {
  const { config } = opts;
  const variants = config.variants?.length ? config.variants : [{ name: "baseline" }];
  const trials = config.trials ?? 1;
  const autonomy = config.autonomy ?? "medium";
  const startedAt = new Date().toISOString();
  const results: TrialResult[] = [];
  for (const model of config.models)
    for (const variant of variants)
      for (const task of opts.tasks)
        for (let t = 1; t <= trials; t++) {
          const r = await runTrial({ task, model, variant, trial: t, autonomy, timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: opts.env });
          results.push(r);
          opts.onResult?.(r);
        }
  return { schema: 1, buildId: opts.buildId, startedAt, finishedAt: new Date().toISOString(), autonomy, trials, results };
}
