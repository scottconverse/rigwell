import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { importSharedSource } from "./transfer.ts";
import { forkImportedSession, renderSharedSession, sharedSession } from "./session.ts";

export async function sharingMain(action: "import" | "export", argv: string[]) {
  if (action === "export") {
    const [id, output, ...flags] = argv;
    if (!id || !output || flags.length) throw new Error("Usage: rigwell export <session-id> <file.html|file.md>");
    const format = output.endsWith(".html") ? "html" : output.endsWith(".md") ? "markdown" : undefined;
    if (!format) throw new Error("Choose an .html or .md export file");
    const file = resolve(output), content = renderSharedSession(sharedSession(id), format);
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ file, format, redacted: true })); return;
  }
  const [source, ...flags] = argv;
  if (!source) throw new Error("Usage: rigwell import <file|url> [--fork --cwd <folder>]");
  let fork = false, cwd: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--fork") fork = true;
    else if (flags[i] === "--cwd" && flags[i + 1]) cwd = resolve(flags[++i]!);
    else throw new Error(`Unknown import option: ${flags[i]}`);
  }
  if ((fork && !cwd) || (!fork && cwd)) throw new Error("Use --fork and --cwd together to continue an imported session");
  const imported = await importSharedSource(source);
  console.log(JSON.stringify({ ...imported, ...(fork ? { fork: await forkImportedSession(imported.importId, cwd!) } : {}) }));
}
