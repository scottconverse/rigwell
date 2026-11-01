import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../core/types.ts";
import { listMatching } from "./glob.ts";
import { runRg } from "./rg.ts";
import { boolArg, fail, intArg, ok, promptDesc, promptSchema, resolvePath, strArg } from "./util.ts";

export const SEARCH_DEFAULT_LIMIT = 200;

export function createGrepTool(): Tool {
  return {
    name: "Grep",
    description: promptDesc("Grep"),
    inputSchema: promptSchema("Grep"),
    category: "read",
    async run(input, ctx) {
      const pattern = strArg(input, "pattern");
      if (pattern === undefined || pattern === "") return fail("pattern is required.");
      const target = resolvePath(strArg(input, "path") || ".", ctx.cwd);
      if (!fs.existsSync(target)) return fail(`path ${target} does not exist.`);
      const output = strArg(input, "output") ?? "files";
      if (!["files", "content", "count"].includes(output)) return fail(`output must be files, content or count.`);
      const limit = Math.max(1, intArg(input, "limit") ?? SEARCH_DEFAULT_LIMIT);
      const args = ["--color=never", "--no-heading", "--no-config", "--no-require-git", "--sort=path"];
      if (output === "files") args.push("-l");
      else if (output === "count") args.push("-c", "--with-filename");
      else {
        args.push("-n", "--with-filename");
        const c = intArg(input, "context");
        if (c !== undefined && c > 0) args.push("-C", String(Math.min(c, 20)));
      }
      if (boolArg(input, "ignoreCase")) args.push("-i");
      if (boolArg(input, "fixed")) args.push("-F");
      if (boolArg(input, "multiline")) args.push("-U");
      const glob = strArg(input, "glob");
      let explicitFiles: string[] | undefined;
      if (glob) {
        if (fs.statSync(target).isDirectory()) {
          // rg -g would also search ignored files, so match the glob ourselves.
          const res = await listMatching(target, glob, false, ctx.signal);
          if (res.error) return fail(res.error);
          if (res.files!.length === 0) return ok("No matches found.");
          if (res.files!.length <= 3000) explicitFiles = res.files;
          else args.push("-g", glob);
        } else {
          args.push("-g", glob);
        }
      }
      const type = strArg(input, "type");
      if (type) args.push("-t", type);
      args.push("-e", pattern, "--");
      // Run from the working directory; pass a relative path when inside it so output stays short.
      const rel = path.relative(ctx.cwd, target);
      const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
      const show = (abs: string) => {
        const r = path.relative(ctx.cwd, abs);
        return r.startsWith("..") || path.isAbsolute(r) ? abs : r;
      };
      if (explicitFiles) args.push(...explicitFiles.map(show));
      else if (!(inside && rel === "")) args.push(inside ? rel : target);

      const r = await runRg(args, ctx.cwd, ctx.signal, limit);
      if (r.missing) return fail("ripgrep (rg) is not installed or not on PATH.");
      if (r.code === 2 && r.stdout.trim() === "" && !r.cut) {
        return fail(`Search failed: ${r.stderr.trim() || "rg exited with code 2"}`);
      }
      let lines = r.stdout.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) return ok("No matches found.");
      let cut = r.cut;
      if (lines.length > limit) {
        lines = lines.slice(0, limit);
        cut = true;
      }
      let text = lines.join("\n");
      if (cut) {
        text += `\n[Results cut at ${limit} ${output === "content" ? "lines" : "entries"}. Narrow the search (path, glob, type, a more specific pattern) to see the rest.]`;
      }
      if (r.code === 2 && r.stderr.trim()) text += `\n[Some paths could not be searched: ${r.stderr.trim().split("\n")[0]}]`;
      return ok(text);
    },
  };
}
