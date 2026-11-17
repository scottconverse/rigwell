import { resolve } from "node:path";
import { buildWiki, readWikiPage, searchWiki } from "./wiki.ts";
import { wikiWalkthrough } from "./video.ts";

export async function wikiMain(argv: string[]) {
  const [action = "help", ...args] = argv; let cwd = process.cwd(), afterCommit = false, mp4 = false; const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") { if (!args[i + 1]) throw new Error("--cwd needs a folder"); cwd = resolve(args[++i]!); }
    else if (args[i] === "--after-commit") afterCommit = true;
    else if (args[i] === "--mp4") mp4 = true;
    else if (args[i]!.startsWith("--")) throw new Error(`Unknown wiki option ${args[i]}`);
    else words.push(args[i]!);
  }
  if (["build", "update"].includes(action)) process.stdout.write(JSON.stringify(await buildWiki(cwd, { afterCommit }), null, 2) + "\n");
  else if (action === "list" || action === "search") process.stdout.write(JSON.stringify(searchWiki(cwd, words.join(" ")), null, 2) + "\n");
  else if (action === "read") process.stdout.write(readWikiPage(cwd, words[0] ?? "overview.md"));
  else if (action === "video") {
    const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { process.stdout.write(JSON.stringify(await wikiWalkthrough(cwd, { mp4, signal: controller.signal }), null, 2) + "\n"); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } else {
    process.stdout.write("rigwell wiki build|update [--after-commit] [--cwd folder]\nrigwell wiki list|search [query] [--cwd folder]\nrigwell wiki read [page.md] [--cwd folder]\nrigwell wiki video [--mp4] [--cwd folder]\n");
    if (!["help", "--help"].includes(action)) throw new Error("Unknown wiki action");
  }
}
