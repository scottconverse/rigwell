// `rigwell eval ...` subcommands: run, report, tasks.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSettings } from "../storage/settings.ts";
import { resolveModels } from "../storage/models.ts";
import { buildReport, parseSince, renderMarkdown, selectRuns } from "./report.ts";
import { runEval } from "./runner.ts";
import { currentBuildId, evalDir, loadRuns, saveRun } from "./store.ts";
import { defaultTasksDir, loadTasks } from "./tasks.ts";
import type { EvalConfig } from "./types.ts";

export const EVAL_USAGE = `Usage:
  rigwell eval run [--config <file>] [--tasks <dir>] [--task a,b] [--model id,id] [--trials n]
                   [--auto low|medium|high] [--build <id>]
  rigwell eval report [--since 7d] [--build <id>] [--against <id>] [--json] [--out <file>]
  rigwell eval tasks [--tasks <dir>]

Config default: $RIGWELL_HOME/eval/config.json. Without one, every custom model in settings runs unpriced.
Results: $RIGWELL_HOME/eval/runs/<build>/<timestamp>.json (build = git short sha, or --build).`;

function fail(msg: string): never {
  process.stderr.write(`rigwell eval: ${msg}\n`);
  process.exit(2);
}

function flags(argv: string[]): { opts: Record<string, string>; bools: Set<string> } {
  const opts: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) fail(`unexpected argument ${k}\n${EVAL_USAGE}`);
    const name = k.slice(2);
    if (name === "json") bools.add(name);
    else opts[name] = argv[++i] ?? fail(`${k} needs a value`);
  }
  return { opts, bools };
}

export function loadConfig(path?: string): EvalConfig {
  const file = path ? resolve(path) : join(evalDir(), "config.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as EvalConfig;
  if (path) fail(`config not found: ${file}`);
  const models = resolveModels(loadSettings({ cwd: process.cwd() }).settings);
  if (!models.length) fail(`no config at ${file} and no custom models in settings`);
  return { models: models.map((m) => ({ id: m.id })) };
}

export async function evalMain(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { opts, bools } = flags(rest);
  if (sub === "run") {
    const config = loadConfig(opts.config);
    if (opts.model) config.models = config.models.filter((m) => opts.model!.split(",").includes(m.id));
    if (!config.models.length) fail("no models selected");
    if (opts.trials) config.trials = Number(opts.trials);
    if (opts.auto) config.autonomy = opts.auto as EvalConfig["autonomy"];
    const tasks = loadTasks(opts.tasks ? resolve(opts.tasks) : config.tasksDir ? resolve(config.tasksDir) : defaultTasksDir(), opts.task?.split(","));
    const buildId = opts.build ?? currentBuildId();
    const run = await runEval({
      config, tasks, buildId,
      onResult: (r) => process.stderr.write(`[eval] ${r.model} [${r.variant}] ${r.task} #${r.trial}: ${r.passed ? "pass" : "FAIL (" + r.failKind + ")"} ${r.requests} req ${(r.wallMs / 1000).toFixed(1)}s $${r.costUsd.toFixed(4)}\n`),
    });
    const file = saveRun(run);
    process.stdout.write(`${file}\n`);
    const passed = run.results.filter((r) => r.passed).length;
    process.stderr.write(`[eval] build ${buildId}: ${passed}/${run.results.length} passed\n`);
    process.exit(0);
  }
  if (sub === "report") {
    const runs = loadRuns();
    const { current, previous } = selectRuns(runs, { sinceMs: opts.since ? parseSince(opts.since) : undefined, build: opts.build, against: opts.against });
    if (!current) fail(opts.since ? `no runs in the last ${opts.since}` : "no runs stored; run `rigwell eval run` first");
    const report = buildReport(current, previous);
    const text = bools.has("json") ? JSON.stringify(report, null, 2) + "\n" : renderMarkdown(report);
    if (opts.out) writeFileSync(resolve(opts.out), text);
    else process.stdout.write(text);
    process.exit(0);
  }
  if (sub === "tasks") {
    for (const t of loadTasks(opts.tasks ? resolve(opts.tasks) : defaultTasksDir())) process.stdout.write(`${t.name}\t${t.prompt.split("\n")[0]}\n`);
    process.exit(0);
  }
  process.stderr.write(EVAL_USAGE + "\n");
  process.exit(sub ? 2 : 0);
}
