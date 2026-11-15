import { lessonById, LESSONS } from "./catalog.ts";
import { readFileSync } from "node:fs";
import { checkPractice, createPracticeWorktree, listPractice, readPractice, removePractice, savePractice, startPractice } from "./practice.ts";

export async function learnMain(argv: string[]) {
  const [action = "list", id] = argv;
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  if (action === "list") { for (const l of LESSONS) process.stdout.write(`${l.id}: ${l.title}\n`); }
  else if (action === "practice") { if (!id) throw new Error("learn practice needs a lesson id"); out(startPractice(id)); }
  else if (action === "practices") out(listPractice());
  else if (action === "read") out(readPractice(id ?? ""));
  else if (action === "save") out(savePractice(id ?? "", readFileSync(0, "utf8")));
  else if (action === "check") { const result = checkPractice(id ?? ""); out(result); if (!result.passed) process.exitCode = 1; }
  else if (action === "worktree") out(createPracticeWorktree(id ?? ""));
  else if (action === "remove") { if (!argv.includes("--yes")) throw new Error("Use --yes to confirm removal of the owned sample and all edits"); out(removePractice(id ?? "", true)); }
  else if (action === "help" || action === "--help") process.stdout.write("rigwell learn [list|<lesson>]\nrigwell learn practice <lesson>\nrigwell learn practices|read <id>|save <id> (content on stdin)|check <id>|worktree <id>|remove <id> --yes\nPractice edits stay in an owned temporary Git repository. Checks validate formats, not live agents.\n");
  else process.stdout.write(lessonById(action).body + "\n");
}
