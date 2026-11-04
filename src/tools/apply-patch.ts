// ApplyPatch: edits several files from one patch text (spec 4.6.4, 5.5.4). Rigwell's patch format:
//
//   *** Begin Patch
//   *** Add File: path          (every following line starts with +)
//   *** Update File: path       (hunks, each starting with a line "@@" or "@@ text")
//   @@
//    context line              (a space keeps the line)
//   -removed line
//   +added line
//   *** Delete File: path
//   *** End Patch
//
// The spec's OpenAI profile sends it as a freeform "custom" tool with a grammar. This build has no custom tool
// type, so it is a function with one `input` string parameter (the allowed fallback) and the grammar below is
// checked by `parsePatch`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../core/types.ts";
import { checkFresh, errMessage, fail, recordOf, resolvePath, strArg } from "./util.ts";

export type PatchOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; hunks: { header: string; lines: { op: " " | "-" | "+"; text: string }[] }[] };

export class PatchError extends Error {}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines[0]?.trim() !== "*** Begin Patch") throw new PatchError('The patch must start with "*** Begin Patch".');
  if (lines[lines.length - 1]?.trim() !== "*** End Patch") throw new PatchError('The patch must end with "*** End Patch".');
  const ops: PatchOp[] = [];
  let i = 1;
  const end = lines.length - 1;
  while (i < end) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(l))) {
      const body: string[] = [];
      i++;
      while (i < end && !lines[i]!.startsWith("*** ")) {
        if (!lines[i]!.startsWith("+")) throw new PatchError(`Line ${i + 1}: every line of an added file must start with "+".`);
        body.push(lines[i]!.slice(1));
        i++;
      }
      ops.push({ kind: "add", path: m[1]!.trim(), content: body.length ? body.join("\n") + "\n" : "" });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(l))) {
      ops.push({ kind: "delete", path: m[1]!.trim() });
      i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(l))) {
      const hunks: { header: string; lines: { op: " " | "-" | "+"; text: string }[] }[] = [];
      i++;
      while (i < end && !lines[i]!.startsWith("*** ")) {
        if (!lines[i]!.startsWith("@@")) throw new PatchError(`Line ${i + 1}: a hunk must start with "@@".`);
        const h = { header: lines[i]!.slice(2).trim(), lines: [] as { op: " " | "-" | "+"; text: string }[] };
        i++;
        while (i < end && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("*** ")) {
          const c = lines[i]![0];
          if (c !== " " && c !== "-" && c !== "+") throw new PatchError(`Line ${i + 1}: a hunk line must start with " ", "-" or "+".`);
          h.lines.push({ op: c, text: lines[i]!.slice(1) });
          i++;
        }
        if (!h.lines.some((x) => x.op !== " ")) throw new PatchError(`Line ${i}: a hunk without changes.`);
        hunks.push(h);
      }
      if (!hunks.length) throw new PatchError(`Update of ${m[1]} has no hunks.`);
      ops.push({ kind: "update", path: m[1]!.trim(), hunks });
    } else {
      throw new PatchError(`Line ${i + 1}: expected "*** Add File:", "*** Update File:" or "*** Delete File:", got: ${l.slice(0, 60)}`);
    }
  }
  if (!ops.length) throw new PatchError("The patch changes nothing.");
  return ops;
}

/** Paths a patch text touches (for permission prompts); empty when it does not parse. */
export function patchPaths(text: string): string[] {
  try { return parsePatch(text).map((o) => o.path); } catch { return []; }
}

function applyHunks(original: string, hunks: Extract<PatchOp, { kind: "update" }>["hunks"], file: string): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const src = original.replace(/\r\n/g, "\n").split("\n");
  const trailing = src[src.length - 1] === "";
  if (trailing) src.pop();
  let from = 0;
  for (const h of hunks) {
    const before = h.lines.filter((x) => x.op !== "+").map((x) => x.text);
    const after = h.lines.filter((x) => x.op !== "-").map((x) => x.text);
    const find = (cmp: (a: string, b: string) => boolean) => {
      for (let s = from; s + before.length <= src.length; s++) {
        if (before.every((b, k) => cmp(src[s + k]!, b))) return s;
      }
      return -1;
    };
    let at = find((a, b) => a === b);
    if (at < 0) at = find((a, b) => a.trimEnd() === b.trimEnd());
    if (at < 0) at = find((a, b) => a.trim() === b.trim());
    if (at < 0) throw new PatchError(`A hunk${h.header ? ` (@@ ${h.header})` : ""} does not match ${file}. Read the file again and copy the context lines exactly.`);
    src.splice(at, before.length, ...after);
    from = at + after.length;
  }
  return src.join(eol) + (trailing || src.length === 0 ? eol : "");
}

export const APPLY_PATCH_DESC =
  "Edits, adds or deletes several files with one patch. Send the patch text as `input`.\n" +
  "Format:\n" +
  "*** Begin Patch\n" +
  "*** Add File: <path>        then every line of the new file, each starting with +\n" +
  "*** Update File: <path>     then one or more hunks\n" +
  "*** Delete File: <path>\n" +
  "*** End Patch\n" +
  'A hunk starts with a line `@@` (optionally followed by a note), then lines that start with a space (unchanged context), `-` (removed) or `+` (added). Give enough context lines for the place to be unique. Paths are absolute or relative to the working directory.\n' +
  "You must have read a file in this session before you update or delete it. All changes are checked first; if one hunk does not match, nothing is written.";

export function createApplyPatchTool(): Tool {
  return {
    name: "ApplyPatch",
    description: APPLY_PATCH_DESC,
    inputSchema: {
      type: "object",
      properties: { input: { type: "string", description: "The whole patch, from *** Begin Patch to *** End Patch." } },
      required: ["input"],
      additionalProperties: false,
    },
    category: "edit",
    async run(input, ctx) {
      const text = strArg(input, "input");
      if (!text) return fail("input is required: the patch text.");
      let ops: PatchOp[];
      try { ops = parsePatch(text); } catch (e) { return fail(`Patch rejected: ${(e as Error).message}`); }
      // Phase 1: compute every result in memory.
      const writes: { abs: string; content: string }[] = [];
      const deletes: string[] = [];
      const summary: { path: string; action: string }[] = [];
      try {
        for (const op of ops) {
          const abs = resolvePath(op.path, ctx.cwd);
          if (op.kind === "add") {
            if (fs.existsSync(abs)) return fail(`${abs} already exists; use Update File to change it.`);
            writes.push({ abs, content: op.content });
            summary.push({ path: abs, action: "added" });
            continue;
          }
          let st: fs.Stats;
          try { st = fs.statSync(abs); } catch { return fail(`${abs} does not exist.`); }
          if (!st.isFile()) return fail(`${abs} is not a regular file.`);
          const stale = checkFresh(abs, st, ctx);
          if (stale) return fail(stale);
          if (op.kind === "delete") { deletes.push(abs); summary.push({ path: abs, action: "deleted" }); continue; }
          writes.push({ abs, content: applyHunks(fs.readFileSync(abs, "utf8"), op.hunks, abs) });
          summary.push({ path: abs, action: "updated" });
        }
      } catch (e) {
        return fail(e instanceof PatchError ? e.message : errMessage(e));
      }
      // Phase 2: write.
      // Rewind snapshots: capture every file before the first write, record each result after it.
      for (const w of writes) ctx.snapshots?.before(w.abs);
      for (const d of deletes) ctx.snapshots?.before(d);
      try {
        for (const w of writes) {
          fs.mkdirSync(path.dirname(w.abs), { recursive: true });
          fs.writeFileSync(w.abs, w.content);
          ctx.snapshots?.after(w.abs);
          ctx.readFiles.set(w.abs, recordOf(fs.statSync(w.abs)));
        }
        for (const d of deletes) { fs.rmSync(d); ctx.snapshots?.after(d); ctx.readFiles.delete(d); }
      } catch (e) {
        return fail(`Patch partly applied: ${errMessage(e)}`);
      }
      return { content: JSON.stringify({ files: summary }), data: { files: summary } };
    },
  };
}
