import * as fs from "node:fs";
import type { Tool } from "../core/types.ts";
import { boolArg, errMessage, fail, intArg, ok, recordOf, resolvePath, strArg, promptDesc, promptSchema } from "./util.ts";

export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;

const description = promptDesc("Read", { READ_DEFAULT_LIMIT: String(2000), READ_MAX_LINE_CHARS: String(2000) });

const inputSchema = promptSchema("Read");

export function createReadTool(): Tool {
  return {
    name: "Read",
    description,
    inputSchema,
    category: "read",
    async run(input, ctx) {
      const p = strArg(input, "path");
      if (!p) return fail("path is required.");
      const abs = resolvePath(p, ctx.cwd);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        return fail(`Cannot read ${abs}: ${errMessage(e)}`);
      }
      if (st.isDirectory()) {
        return fail(`${abs} is a directory, not a file. Use Glob to list its files.`);
      }
      if (!st.isFile()) return fail(`${abs} is not a regular file.`);
      if (IMAGE_EXT.test(abs)) {
        return fail(`${abs} is an image; image reading is not supported in this build.`);
      }
      if (st.size > MAX_FILE_BYTES) {
        return fail(`${abs} is too large to read (${st.size} bytes). Use Grep to find the part you need.`);
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch (e) {
        return fail(`Cannot read ${abs}: ${errMessage(e)}`);
      }
      if (buf.subarray(0, 8192).includes(0)) {
        return fail(`${abs} looks like a binary file; it was not read.`);
      }
      const text = buf.toString("utf8");
      const lines = text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
      const total = lines.length;
      const offset = Math.max(1, intArg(input, "offset") ?? 1);
      const limit = Math.max(1, intArg(input, "limit") ?? READ_DEFAULT_LIMIT);
      // Record the read even for an empty file so it can be edited/overwritten.
      ctx.readFiles.set(abs, recordOf(st));
      if (total === 0) return ok(`${abs} is empty (0 lines).`);
      if (offset > total) {
        return fail(`offset ${offset} is past the end of the file, which has ${total} lines.`);
      }
      const end = Math.min(total, offset - 1 + limit);
      const numbers = boolArg(input, "lineNumbers");
      const out: string[] = [];
      for (let i = offset - 1; i < end; i++) {
        let line = lines[i]!;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > READ_MAX_LINE_CHARS) {
          line = `${line.slice(0, READ_MAX_LINE_CHARS)}... [line cut, ${line.length - READ_MAX_LINE_CHARS} more characters]`;
        }
        out.push(numbers ? `${String(i + 1).padStart(6)}\t${line}` : line);
      }
      const more = end < total;
      const footer = more
        ? `[Lines ${offset}-${end} of ${total}. More lines remain; use offset=${end + 1} to continue.]`
        : `[Lines ${offset}-${end} of ${total}. End of file.]`;
      return ok(`${out.join("\n")}\n${footer}`);
    },
  };
}
