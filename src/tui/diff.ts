// Diff text for permission panels and expanded tool blocks (setting `diffMode`, spec 12.2). Pure.
//
//   github   (default)  "+ new text" / "- old text" / "  context" (marker, space, text) under a "<path>  +A -R" summary line,
//                       the way a pull request shows a change.
//   unified             "--- a/<path>", "+++ b/<path>", "@@ -s,n +s,m @@", then lines prefixed "+", "-" or " " (as `git diff`).
//
// Only the changed middle of the two texts is shown, with two lines of context on each side.
export type DiffMode = "github" | "unified";

const CONTEXT = 2;

export function diffBody(oldC: string | undefined, newC: string | undefined, mode: DiffMode = "github", path = ""): string[] {
  const a = oldC === undefined ? [] : oldC.split("\n");
  const b = (newC ?? "").split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let e = 0;
  while (e < a.length - p && e < b.length - p && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const before = Math.max(0, p - CONTEXT);
  const removed = a.slice(p, a.length - e);
  const added = b.slice(p, b.length - e);
  const afterOld = a.slice(a.length - e, a.length - e + CONTEXT);
  const ctxBefore = a.slice(before, p);
  const startOld = before + 1;
  const startNew = before + 1;
  if (mode === "unified") {
    const out: string[] = [`--- ${oldC === undefined ? "/dev/null" : "a/" + (path || "file")}`, `+++ b/${path || "file"}`];
    const nOld = ctxBefore.length + removed.length + afterOld.length;
    const nNew = ctxBefore.length + added.length + afterOld.length;
    out.push(`@@ -${oldC === undefined ? 0 : startOld},${oldC === undefined ? 0 : nOld} +${startNew},${nNew} @@`);
    out.push(...ctxBefore.map((l) => " " + l), ...removed.map((l) => "-" + l), ...added.map((l) => "+" + l), ...afterOld.map((l) => " " + l));
    return out;
  }
  return [
    `${path || "changes"}  +${added.length} -${removed.length}`,
    ...ctxBefore.map((l) => "  " + l), ...removed.map((l) => "- " + l), ...added.map((l) => "+ " + l), ...afterOld.map((l) => "  " + l),
  ];
}

/** True for a diff line the renderer should colour green (added). */
export const isAddedLine = (l: string) => (l.startsWith("+") && !l.startsWith("+++ ")) || false;
/** True for a diff line the renderer should colour red (removed). */
export const isRemovedLine = (l: string) => (l.startsWith("-") && !l.startsWith("--- ")) || false;
