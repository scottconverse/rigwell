import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGrader } from "../../src/eval/runner.ts";

test("grader diagnostics retain actual and expected values across blank assertion lines", () => {
  const root = mkdtempSync(join(tmpdir(), "rigwell-grader-detail-"));
  try {
    writeFileSync(join(root, "grade.cjs"), "require('node:assert/strict').equal('actual-value','expected-value');");
    const result = runGrader({ name: "diagnostic", dir: root, fixtureDir: root, prompt: "fixture", grader: 'node "$EVAL_TASK_DIR/grade.cjs"', budget: {} }, root);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("actual-value");
    expect(result.detail).toContain("expected-value");
    expect(result.detail.length).toBeLessThanOrEqual(300);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
