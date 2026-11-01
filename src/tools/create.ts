import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../core/types.ts";
import { boolArg, checkFresh, countLines, errMessage, fail, ok, recordOf, resolvePath, strArg, promptDesc, promptSchema } from "./util.ts";

const description = promptDesc("Create");

const inputSchema = promptSchema("Create");

export function createCreateTool(): Tool {
  return {
    name: "Create",
    description,
    inputSchema,
    category: "edit",
    async run(input, ctx) {
      const p = strArg(input, "path");
      const content = strArg(input, "content");
      if (!p) return fail("path is required.");
      if (content === undefined) return fail("content is required.");
      const abs = resolvePath(p, ctx.cwd);
      let st: fs.Stats | undefined;
      try {
        st = fs.statSync(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return fail(`Cannot create ${abs}: ${errMessage(e)}`);
      }
      if (st) {
        if (st.isDirectory()) return fail(`${abs} is a directory.`);
        if (!boolArg(input, "overwrite")) {
          return fail(`${abs} already exists. To change part of it use Edit; to replace it entirely, Read it and then call Create with overwrite: true.`);
        }
        const stale = checkFresh(abs, st, ctx);
        if (stale) return fail(stale);
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        ctx.snapshots?.before(abs);
        fs.writeFileSync(abs, content);
        ctx.snapshots?.after(abs);
        ctx.readFiles.set(abs, recordOf(fs.statSync(abs)));
      } catch (e) {
        return fail(`Cannot write ${abs}: ${errMessage(e)}`);
      }
      return ok(JSON.stringify({ path: abs, bytes: Buffer.byteLength(content), lines: countLines(content) }));
    },
  };
}
