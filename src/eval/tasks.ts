// Task loading. A task is a folder:
//   task.json   { "grader": "node \"$EVAL_TASK_DIR/grade.js\"", "budget": { timeoutMs, maxRequests, maxCostUsd } }
//   prompt.txt  the prompt sent to the agent
//   repo/       the starting repo fixture
//   (grader files live beside these, outside repo/, so the agent never sees them)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskDef } from "./types.ts";

export function defaultTasksDir(): string {
  return join(import.meta.dir, "../../evals/tasks");
}

export function loadTask(dir: string): TaskDef {
  const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
  if (typeof meta.grader !== "string" || !meta.grader.trim()) throw new Error(`${dir}/task.json: grader is required`);
  const fixtureDir = join(dir, "repo");
  if (!existsSync(fixtureDir)) throw new Error(`${dir}: missing repo/ fixture`);
  return {
    name: basename(dir),
    dir,
    fixtureDir,
    prompt: readFileSync(join(dir, "prompt.txt"), "utf8").trim(),
    grader: meta.grader,
    budget: meta.budget ?? {},
  };
}

export function loadTasks(tasksDir = defaultTasksDir(), only?: string[]): TaskDef[] {
  const names = readdirSync(tasksDir).filter((n) => statSync(join(tasksDir, n)).isDirectory()).sort();
  if (only?.length) for (const o of only) if (!names.includes(o)) throw new Error(`unknown task: ${o}`);
  const picked = only?.length ? names.filter((n) => only.includes(n)) : names;
  return picked.map((n) => loadTask(join(tasksDir, n)));
}
