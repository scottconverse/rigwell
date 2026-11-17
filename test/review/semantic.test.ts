import { expect, test } from "bun:test";
import { semanticDiff } from "../../src/review/semantic.ts";

test("tree-sitter identifies changed, added and removed functions/classes without treating a line shift as a move", async () => {
  const result = await semanticDiff([{ path: "code.ts", before: 'class Keep { method() { return 1; } }\nfunction removed() {}\nfunction unchanged() { return "a b"; }', after: '// shifted\nclass Keep { method() { return 2; } }\nfunction added() { return 3; }\nfunction unchanged() { return "a b"; }' }]);
  expect(result.changes.map((c) => [c.kind, c.name])).toEqual([["changed", "Keep"], ["changed", "Keep.method"], ["removed", "removed"], ["added", "added"]]);
  expect(result.warnings).toHaveLength(0);
});

test("moves across files and declaration renames retain their old/new locations", async () => {
  const result = await semanticDiff([
    { path: "old.ts", before: "export function oldName(x: number) { return x + 1; }", after: "" },
    { path: "new.ts", before: "", after: "export function newName(x: number) { return x + 1; }" },
  ]);
  expect(result.changes).toMatchObject([{ kind: "moved", renamed: true, from: { path: "old.ts", name: "oldName", line: 1 }, to: { path: "new.ts", name: "newName", line: 1 } }]);
  expect(result.changes).toHaveLength(1);
});

test("syntax-aware comparison preserves string contents and supports assigned functions, Python and unsupported files", async () => {
  const result = await semanticDiff([
    { path: "one.ts", before: 'const arrow = () => "a b";', after: 'const arrow = () => "ab";' },
    { path: "one.py", before: "def old():\n    return 1\n", after: "def renamed():\n    return 1\n" },
    { path: "notes.txt", before: "function imaginary() {}", after: "function pretend() {}" },
  ]);
  expect(result.changes).toMatchObject([{ kind: "changed", name: "arrow" }, { kind: "moved", name: "renamed", renamed: true }]);
  expect(result.warnings).toMatchObject([{ path: "notes.txt", message: expect.stringContaining("No bundled") }]);
});

test("reordering declarations is a move and duplicate bodies remain unambiguously paired", async () => {
  const result = await semanticDiff([{ path: "one.js", before: "function first() { return 1; }\nfunction second() { return 1; }", after: "function second() { return 1; }\nfunction first() { return 1; }" }]);
  expect(result.changes.every((c) => c.kind === "moved")).toBe(true); expect(result.changes).toHaveLength(2);
});
