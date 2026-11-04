import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../core/types.ts";
import { runRg } from "./rg.ts";
import { boolArg, fail, intArg, ok, promptDesc, promptSchema, resolvePath, strArg } from "./util.ts";

/**
 * Lists files under dir whose dir-relative path matches the glob. rg's own -g flag
 * would override .gitignore (a positive glob whitelists ignored files), so rg only
 * lists files and the glob is applied here. A pattern without "/" matches at any depth.
 */
export async function listMatching(
  dir: string,
  pattern: string,
  includeIgnored: boolean,
  signal: AbortSignal,
): Promise<{ files?: string[]; error?: string }> {
  const args = ["--files", "--no-config", "--no-require-git"];
  if (process.platform === "win32") args.push("--path-separator", "/"); // so the glob sees "/" like everywhere else
  if (includeIgnored) args.push("--no-ignore", "--hidden");
  const r = await runRg(args, dir, signal);
  if (r.missing) return { error: "ripgrep (rg) is not installed or not on PATH." };
  if (r.code === 2 && r.stdout.trim() === "") return { error: `File listing failed: ${r.stderr.trim() || "rg exited with code 2"}` };
  const g = new Bun.Glob(pattern.includes("/") ? pattern.replace(/^\.\//, "") : `**/${pattern}`);
  return { files: r.stdout.split("\n").filter((f) => f && g.match(f)).map((f) => path.resolve(dir, f)) };
}

export function createGlobTool(): Tool {
  return {
    name: "Glob",
    description: promptDesc("Glob"),
    inputSchema: promptSchema("Glob"),
    category: "read",
    async run(input, ctx) {
      const pattern = strArg(input, "pattern");
      if (!pattern) return fail("pattern is required.");
      const dir = resolvePath(strArg(input, "path") || ".", ctx.cwd);
      try {
        if (!fs.statSync(dir).isDirectory()) return fail(`path ${dir} is not a directory.`);
      } catch {
        return fail(`path ${dir} does not exist.`);
      }
      const limit = Math.max(1, intArg(input, "limit") ?? 200);
      const res = await listMatching(dir, pattern, boolArg(input, "includeIgnored"), ctx.signal);
      if (res.error) return fail(res.error);
      const files = res.files!;
      if (files.length === 0) return ok("No files matched.");
      const withTime: { f: string; t: number }[] = [];
      for (let i = 0; i < files.length; i += 200) {
        const chunk = files.slice(i, i + 200);
        const stats = await Promise.all(chunk.map((f) => fs.promises.stat(f).then((s) => s.mtimeMs, () => 0)));
        chunk.forEach((f, j) => withTime.push({ f, t: stats[j]! }));
      }
      withTime.sort((a, b) => b.t - a.t || a.f.localeCompare(b.f));
      const shown = withTime.slice(0, limit).map((x) => x.f);
      let text = shown.join("\n");
      if (withTime.length > limit) {
        text += `\n[Showing the ${limit} newest of ${withTime.length} matches. Narrow the pattern or path to see the rest.]`;
      }
      return ok(text);
    },
  };
}
