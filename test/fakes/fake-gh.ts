// A stand-in for the `gh` CLI in tests. It reads its answers from fake-gh.json in the FAKE_GH_DIR folder and
// appends each call's arguments to calls.jsonl there.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_GH_DIR!;
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd() }) + "\n");
const cfg = existsSync(join(dir, "fake-gh.json")) ? JSON.parse(readFileSync(join(dir, "fake-gh.json"), "utf8")) : {};
if (args[0] === "pr" && args[1] === "create") {
  if (cfg.createError) { console.error(cfg.createError); process.exit(1); }
  console.log("Creating pull request...\n" + (cfg.createUrl ?? "https://github.com/acme/widget/pull/7"));
} else if (args[0] === "pr" && args[1] === "view") {
  if (!cfg.view) { console.error(`no pull requests found for branch "${args[2]}"`); process.exit(1); }
  console.log(JSON.stringify(cfg.view));
} else {
  console.error(`fake gh: unknown command ${args.join(" ")}`);
  process.exit(2);
}
