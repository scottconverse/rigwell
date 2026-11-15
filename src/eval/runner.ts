// Runs model x variant x task trials by driving `rigwell exec --input-format stream-jsonrpc` as a child process.
// Only the public wire surface is used (spec section 3.1): initialize_session, add_user_message, notifications.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { shellInvocation } from "../platform/shell.ts";
import { cacheHitRate, costOf } from "./cost.ts";
import type { EvalConfig, ExternalHarness, FailKind, ModelSpec, RunRecord, TaskDef, TokenCounts, TrialResult, Variant } from "./types.ts";
import { parseSharedSession, type SharedSession } from "../sharing/format.ts";
import { configuredSecretValues, redactSharedText } from "../sharing/redact.ts";
import { judgeOutput } from "./judge.ts";

export const CLI_PATH = join(import.meta.dir, "../cli/main.ts");
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const GRADER_TIMEOUT_MS = 120_000;

export interface SessionOutcome {
  turnReason: string;
  requests: number;
  tokens: TokenCounts;
  killed: "none" | "budget" | "timeout";
  error?: string;
  sessionId?: string;
  output?: string;
  transcript?: SharedSession;
  transcriptUnavailable?: string;
}

const zeroTokens = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

/** Runs one prompt to the end of its turn in a fresh `rigwell exec` child. Unattended: permission asks are declined. */
export async function driveSession(opts: {
  cwd: string; modelId: string; autonomy: string; prompt: string; settingsPath?: string;
  toolExecutionMode?: string; timeoutMs: number; maxRequests?: number; maxCostUsd?: number;
  price?: ModelSpec["prices"]; env?: Record<string, string>;
  harness?: ExternalHarness;
  reasoningEffort?: ModelSpec["reasoningEffort"];
}): Promise<SessionOutcome> {
  const args = ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc", "--auto", opts.autonomy, "-m", opts.modelId, "--cwd", opts.cwd];
  const settingsPath = opts.harness?.settingsPath ?? opts.settingsPath;
  if (settingsPath) args.push("--settings", settingsPath);
  const proc = Bun.spawn([...(opts.harness?.command ?? ["bun", CLI_PATH]), ...args], {
    cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderrP = new Response(proc.stderr as ReadableStream).text();
  const send = (m: object) => { try { (proc.stdin as any).write(JSON.stringify({ ...opts.harness?.envelope, ...m }) + "\n"); } catch { /* child gone */ } };

  let usageEvents = 0;
  let lastUsageSig = "";
  let completed = false;
  let tokens = zeroTokens();
  let turnReason = "";
  let killed: SessionOutcome["killed"] = "none";
  let error: string | undefined;
  let sessionId: string | undefined, transcript: SharedSession | undefined, transcriptUnavailable: string | undefined;
  const texts = new Map<string, string>();
  let n = 0;
  const pending = new Map<string, (m: any) => void>();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const id = `ev-${++n}`;
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", type: "request", id, method: `${opts.harness?.methodPrefix ?? "rigwell."}${method}`, params });
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
    if (note.type === "assistant_text_delta" && typeof note.textDelta === "string") {
      const id = String(note.messageId ?? "answer"); texts.set(id, (texts.get(id) ?? "") + note.textDelta);
    } else if (note.type === "llm_retry") texts.clear();
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
      request("initialize_session", { machineId: "default", cwd: opts.cwd, modelId: opts.modelId, autonomyLevel: opts.autonomy, ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}), ...(opts.toolExecutionMode ? { toolExecutionMode: opts.toolExecutionMode } : {}) }),
      done.then(() => null),
    ]);
    if (init?.error) error = `initialize_session: ${init.error.message}`;
    else if (init) {
      sessionId = init.result?.sessionId;
      const added = await Promise.race([request("add_user_message", { text: opts.prompt, messageId: "eval-turn" }), done.then(() => null)]);
      if (added?.error) error = `add_user_message: ${added.error.message}`;
      else await done;
    }
  } finally {
    clearTimeout(timer);
    if (!completed && killed === "none" && !error) error = "session ended before the turn completed: " + (await Promise.race([stderrP, Bun.sleep(200).then(() => "")])).slice(-300);
    if (completed && !opts.harness && sessionId) {
      try {
        const exported = await Promise.race([request("export_session", { format: "markdown" }), Bun.sleep(2000).then(() => null)]);
        if (!exported?.result?.content) throw new Error(exported?.error?.message ?? "Transcript export unavailable");
        transcript = parseSharedSession(exported.result.content);
      } catch (e) { transcriptUnavailable = String((e as Error).message).slice(0, 300); }
    } else transcriptUnavailable = opts.harness ? "The external harness did not expose a stored transcript." : "The turn ended before a completed transcript could be exported.";
    if (completed) await Promise.race([request("close_session", { reason: "other" }), Bun.sleep(2000)]);
    try { (proc.stdin as any).end(); } catch { /* ignore */ }
    const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
    if (exited === null) try { proc.kill(); } catch { /* ignore */ }
  }
  const requests = usageEvents;
  const output = redactSharedText(transcript?.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? [...texts.values()].at(-1) ?? "", configuredSecretValues(opts.cwd));
  return { turnReason: turnReason || (killed !== "none" ? killed : "error"), requests, tokens, killed, error, sessionId, output, ...(transcript ? { transcript } : { transcriptUnavailable }) };
}

/** Runs the grader in the working copy. Exit 0 passes; the last lines of its output are the detail. */
export function runGrader(task: TaskDef, workDir: string): { passed: boolean; detail: string } {
  const command = process.platform === "win32"
    ? task.grader.replace(/\$EVAL_TASK_DIR\b/g, "%EVAL_TASK_DIR%").replace(/\$EVAL_WORK_DIR\b/g, "%EVAL_WORK_DIR%")
    : task.grader;
  const shell = shellInvocation(command);
  const r = spawnSync(shell.file, shell.args, {
    windowsVerbatimArguments: shell.windowsVerbatimArguments,
    cwd: workDir, encoding: "utf8", windowsHide: true, timeout: GRADER_TIMEOUT_MS, env: { ...process.env, EVAL_TASK_DIR: task.dir, EVAL_WORK_DIR: workDir },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(0, 2).join(" | ").slice(0, 300);
  return { passed: r.status === 0, detail: out || (r.error ? String(r.error.message) : `exit ${r.status}`) };
}

function prepareWorkDir(task: TaskDef): string {
  const dir = mkdtempSync(join(tmpdir(), `rigwell-eval-${task.name}-`));
  cpSync(task.fixtureDir, dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", ...a], { cwd: dir, stdio: "ignore", windowsHide: true });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return dir;
}

export async function runTrial(opts: {
  task: TaskDef; model: ModelSpec; variant: Variant; trial: number; autonomy: string; timeoutMs: number; env?: Record<string, string>;
  harness?: ExternalHarness;
  judgeModel?: string;
  judgePrice?: ModelSpec["prices"];
}): Promise<TrialResult> {
  const { task, model, variant } = opts;
  if (task.rubric && !opts.judgeModel) throw new Error("This task has a rubric; explicitly select judgeModel before running it");
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
      cwd: work, modelId: opts.harness?.modelMap[model.id] ?? model.id, autonomy: opts.autonomy, prompt: task.prompt, settingsPath, harness: opts.harness,
      toolExecutionMode: variant.toolExecutionMode, timeoutMs: task.budget.timeoutMs ?? opts.timeoutMs,
      maxRequests: task.budget.maxRequests, maxCostUsd: task.budget.maxCostUsd, price: model.prices, env: opts.env, reasoningEffort: model.reasoningEffort,
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
    const g = task.expectedOutput !== undefined ? { passed: (outcome.output ?? "").trim() === task.expectedOutput.trim(), detail: "Exact expected-output comparison" } : task.grader ? runGrader(task, work) : { passed: !!task.rubric, detail: "No command check; rubric only" };
    passed = g.passed;
    detail = g.detail;
    if (!passed) failKind = "grader";
  }
  const checkPassed = passed;
  let judge: TrialResult["judge"];
  if (task.rubric && opts.judgeModel && !outcome.error && outcome.killed === "none" && failKind !== "budget") {
    let diff = ""; try { diff = execFileSync("git", ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"], { cwd: work, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10_000 }); } catch { diff = "Diff unavailable or exceeds 1 MiB."; }
    judge = await judgeOutput({ model: opts.judgeModel, rubric: task.rubric, prompt: task.prompt, output: outcome.output ?? "", diff, cwd: work, price: opts.judgePrice });
    if (judge.status !== "complete" || judge.score! < .7) { passed = false; if (failKind === "none") failKind = "judge"; }
  }
  rmSync(work, { recursive: true, force: true });
  if (settingsPath) rmSync(join(settingsPath, ".."), { recursive: true, force: true });
  return {
    task: task.name, model: model.id, family: model.family ?? model.id, variant: variant.name, trial: opts.trial,
    passed, failKind, graderDetail: detail, turnReason: outcome.turnReason, wallMs, requests: outcome.requests,
    tokens: outcome.tokens, costUsd: costOf(outcome.tokens, model.prices), priced: !!model.prices, cacheHitRate: cacheHitRate(outcome.tokens), ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}), output: outcome.output ?? "", ...(outcome.transcript ? { transcript: outcome.transcript } : { transcriptUnavailable: outcome.transcriptUnavailable ?? "Transcript unavailable" }),
    checkPassed, ...(judge ? { judge } : {}),
  };
}

export async function runEval(opts: {
  config: EvalConfig; tasks: TaskDef[]; buildId: string; env?: Record<string, string>; onResult?: (r: TrialResult) => void;
}): Promise<RunRecord> {
  const { config } = opts;
  if (opts.tasks.some((task) => task.rubric) && !config.judgeModel) throw new Error("Select judgeModel explicitly for rubric tasks");
  const variants = config.variants?.length ? config.variants : [{ name: "baseline" }];
  const trials = config.trials ?? 1;
  const autonomy = config.autonomy ?? "medium";
  const startedAt = new Date().toISOString();
  const results: TrialResult[] = [];
  for (const model of config.models)
    for (const variant of variants)
      for (const task of opts.tasks)
        for (let t = 1; t <= trials; t++) {
          const r = await runTrial({ task, model, variant, trial: t, autonomy, timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: opts.env, judgeModel: config.judgeModel, judgePrice: config.models.find((m) => m.id === config.judgeModel)?.prices });
          results.push(r);
          opts.onResult?.(r);
        }
  return { schema: 1, buildId: opts.buildId, startedAt, finishedAt: new Date().toISOString(), autonomy, trials, results };
}
