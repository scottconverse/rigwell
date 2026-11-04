// LS: lists one directory, or a few levels of it (prompts.md 5.2, spec 5.1 core set).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../core/types.ts";
import { boolArg, fail, intArg, ok, promptDesc, promptSchema, resolvePath, strArg } from "./util.ts";

const BULKY = new Set([".git", "node_modules", "dist", "build", "target"]);
const MAX_ENTRIES = 500;

export interface LsEntry { name: string; type: "file" | "dir" | "link"; size?: number }

/** Asks git which of these paths (relative to dir) are ignored. Outside a repository nothing is ignored. */
function gitIgnored(dir: string, rels: string[]): Set<string> {
  if (!rels.length) return new Set();
  try {
    const r = spawnSync("git", ["check-ignore", "-z", "--stdin"], { cwd: dir, input: rels.join("\0") + "\0", encoding: "utf8", timeout: 5000 });
    if (r.status === 128 || r.error) return new Set();
    return new Set(r.stdout.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

function matcher(patterns: string[]): (rel: string) => boolean {
  const globs = patterns.map((p) => new Bun.Glob(p.includes("/") ? p.replace(/^\.\//, "") : `**/${p}`));
  const names = patterns.filter((p) => !/[/*?[{]/.test(p));
  return (rel) => names.includes(path.basename(rel)) || globs.some((g) => g.match(rel));
}

/** Entries under `root`, `depth` levels deep, names relative to root. Directories sort before files. */
export function listDir(root: string, depth: number, o: { includeIgnored: boolean; ignore: string[] }): { entries: LsEntry[]; truncated: boolean } {
  const entries: LsEntry[] = [];
  const hide = matcher(o.ignore);
  let truncated = false;
  const walk = (dir: string, level: number) => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const relOf = (d: fs.Dirent) => path.relative(root, path.join(dir, d.name)).split(path.sep).join("/");
    let keep = names.filter((d) => o.includeIgnored || !BULKY.has(d.name));
    keep = keep.filter((d) => !hide(relOf(d)));
    if (!o.includeIgnored) {
      const ignored = gitIgnored(root, keep.map((d) => relOf(d) + (d.isDirectory() ? "/" : "")));
      keep = keep.filter((d) => !ignored.has(relOf(d)) && !ignored.has(relOf(d) + "/"));
    }
    keep.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const d of keep) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
      const full = path.join(dir, d.name);
      const rel = relOf(d);
      if (d.isSymbolicLink()) entries.push({ name: rel, type: "link" });
      else if (d.isDirectory()) {
        entries.push({ name: rel + "/", type: "dir" });
        if (level < depth) walk(full, level + 1);
        if (truncated) return;
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* vanished */ }
        entries.push({ name: rel, type: "file", size });
      }
    }
  };
  walk(root, 1);
  return { entries, truncated };
}

export function createLsTool(): Tool {
  return {
    name: "LS",
    description: promptDesc("LS"),
    inputSchema: promptSchema("LS"),
    category: "read",
    async run(input, ctx) {
      const dir = resolvePath(strArg(input, "path") || ".", ctx.cwd);
      let st: fs.Stats;
      try { st = fs.statSync(dir); } catch { return fail(`${dir} does not exist.`); }
      if (!st.isDirectory()) return fail(`${dir} is not a directory. Use Read for a file.`);
      const depth = Math.min(3, Math.max(1, intArg(input, "depth") ?? 1));
      const ignore = Array.isArray(input.ignore) ? input.ignore.filter((x): x is string => typeof x === "string") : [];
      const { entries, truncated } = listDir(dir, depth, { includeIgnored: boolArg(input, "includeIgnored"), ignore });
      const lines = entries.map((e) => (e.type === "file" ? `${e.name}  (${e.size} bytes)` : e.type === "link" ? `${e.name}  (link)` : e.name));
      let text = `${dir}\n${lines.length ? lines.join("\n") : "(empty)"}`;
      if (truncated) text += `\n[Showing the first ${MAX_ENTRIES} entries. List a subfolder or add ignore patterns to see the rest.]`;
      return { content: text, data: { path: dir, entries, truncated } };
    },
  };
}
