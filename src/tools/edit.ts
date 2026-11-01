import * as fs from "node:fs";
import type { Tool } from "../core/types.ts";
import { boolArg, checkFresh, countLines, errMessage, fail, ok, recordOf, resolvePath, strArg, promptDesc, promptSchema } from "./util.ts";

const description = promptDesc("Edit");

const inputSchema = promptSchema("Edit");

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

export function createEditTool(): Tool {
  return {
    name: "Edit",
    description,
    inputSchema,
    category: "edit",
    async run(input, ctx) {
      const p = strArg(input, "path");
      let oldText = strArg(input, "old_text");
      let newText = strArg(input, "new_text");
      if (!p) return fail("path is required.");
      if (oldText === undefined || newText === undefined) return fail("old_text and new_text are required.");
      if (oldText === "") return fail("old_text must not be empty. To write a new file, use Create.");
      if (oldText === newText) return fail("old_text and new_text are identical; nothing to change.");
      const replaceAll = boolArg(input, "replaceAll");
      const abs = resolvePath(p, ctx.cwd);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return fail(`${abs} does not exist. To make a new file, use Create.`);
        }
        return fail(`Cannot edit ${abs}: ${errMessage(e)}`);
      }
      if (!st.isFile()) return fail(`${abs} is not a regular file.`);
      const stale = checkFresh(abs, st, ctx);
      if (stale) return fail(stale);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch (e) {
        return fail(`Cannot read ${abs}: ${errMessage(e)}`);
      }
      let count = countOccurrences(content, oldText);
      if (count === 0 && content.includes("\r\n") && oldText.includes("\n") && !oldText.includes("\r\n")) {
        // File uses CRLF but the model sent LF: match and write in the file's own style.
        const o2 = oldText.replace(/\n/g, "\r\n");
        const c2 = countOccurrences(content, o2);
        if (c2 > 0) {
          oldText = o2;
          newText = newText.replace(/\r?\n/g, "\r\n");
          count = c2;
        }
      }
      if (count === 0) {
        return fail(`old_text was not found in ${abs}. It must match the file exactly, including whitespace. Read the file again and copy the text exactly.`);
      }
      if (count > 1 && !replaceAll) {
        return fail(`old_text occurs ${count} times in ${abs}. Add surrounding lines to make it unique, or set replaceAll to true to change every occurrence.`);
      }
      const replacements = replaceAll ? count : 1;
      const result = replaceAll
        ? content.split(oldText).join(newText)
        : content.slice(0, content.indexOf(oldText)) + newText + content.slice(content.indexOf(oldText) + oldText.length);
      try {
        fs.writeFileSync(abs, result);
        ctx.readFiles.set(abs, recordOf(fs.statSync(abs)));
      } catch (e) {
        return fail(`Cannot write ${abs}: ${errMessage(e)}`);
      }
      return ok(JSON.stringify({
        path: abs,
        replacements,
        linesAdded: countLines(newText) * replacements,
        linesRemoved: countLines(oldText) * replacements,
      }));
    },
  };
}
