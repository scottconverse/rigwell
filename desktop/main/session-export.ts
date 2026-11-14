import { isAbsolute } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseSharedSession, renderSharedSession } from "../../src/sharing/format.ts";

export async function saveSessionExport(format: unknown, content: unknown, choose: (extension: "html" | "md") => Promise<string | null>) {
  if ((format !== "html" && format !== "markdown") || typeof content !== "string") throw new Error("Invalid session export");
  // Rebuild from the inert payload; never write caller-supplied executable HTML.
  const safe = renderSharedSession(parseSharedSession(content), format), extension = format === "html" ? "html" : "md";
  const file = await choose(extension);
  if (!file) return null;
  if (!isAbsolute(file) || !file.toLowerCase().endsWith(`.${extension}`)) throw new Error(`Choose an absolute .${extension} export path`);
  await writeFile(file, safe, { encoding: "utf8", mode: 0o600 }); return file;
}
