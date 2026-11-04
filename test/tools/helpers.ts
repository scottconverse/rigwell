import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "../../src/core/types.ts";

export function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rigwell-tools-")));
}

export function makeCtx(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
  return { cwd, sessionId: "s1", readFiles: new Map(), signal: new AbortController().signal, ...over };
}
