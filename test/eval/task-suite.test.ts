import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { loadTasks } from "../../src/eval/tasks.ts";
import { runGrader } from "../../src/eval/runner.ts";
import solutions from "./task-solutions.json";

const tasks = loadTasks();
test("the shipped task suite covers all six coding categories and every task has a reference patch", () => {
  expect(tasks.length).toBeGreaterThanOrEqual(40);
  expect(new Set(tasks.map((t) => t.category))).toEqual(new Set(["bug-fix", "feature", "refactor", "tests", "terminal", "multi-file"]));
  expect(Object.keys(solutions).sort()).toEqual(tasks.map((t) => t.name).sort());
  for (const task of tasks) { expect(task.prompt.trim().length).toBeGreaterThan(20); expect(task.grader).toContain("grade.cjs"); }
});
for (const task of tasks) test(task.name + ": the actual grader rejects the starting repository and accepts a reference fix", () => {
  const tempRoot = realpathSync.native(tmpdir()), work = mkdtempSync(join(tempRoot, "rigwell-task-check-"));
  if (!resolve(work).startsWith(tempRoot + sep)) throw new Error("Unsafe temporary task path");
  try {
    cpSync(task.fixtureDir, work, { recursive: true });
    const before = runGrader(task, work);
    expect(before.passed, task.name + ": untouched fixture unexpectedly passed: " + before.detail).toBe(false);
    // A real trial starts clean; grader-created files from the failing control are not part of the reference trial.
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    cpSync(task.fixtureDir, work, { recursive: true });
    const patch = (solutions as Record<string, Record<string, string>>)[task.name]!;
    for (const [file, content] of Object.entries(patch)) {
      const target = resolve(work, file);
      if (!target.startsWith(work + sep)) throw new Error("Reference patch escaped fixture");
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
    }
    const after = runGrader(task, work);
    expect(after.passed, task.name + ": reference failed: " + after.detail).toBe(true);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
