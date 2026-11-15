import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function wikiFixture(root: string) {
  const project = join(root, "project"); mkdirSync(join(project, "core"), { recursive: true }); mkdirSync(join(project, "ui"));
  writeFileSync(join(project, "README.md"), "# Fixture project\n\nA small arithmetic library and its presentation layer.\n\n<script>alert('unsafe')</script>\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "wiki-fixture", description: "Local arithmetic", scripts: { postinstall: "must-never-run" } }));
  writeFileSync(join(project, "core/math.ts"), "export function clamp(n: number) { return Math.max(0, n); }\n");
  writeFileSync(join(project, "ui/index.ts"), 'import { clamp } from "../core/math.ts";\nexport function render(n: number) { return String(clamp(n)); }\n');
  writeFileSync(join(project, ".gitignore"), "ignored.ts\n.rigwell/\n"); writeFileSync(join(project, "ignored.ts"), "const doNotRead = 'ignored-value';");
  mkdirSync(join(project, "evidence")); writeFileSync(join(project, "evidence/secret.ts"), "const doNotRead = 'evidence-value';");
  writeFileSync(join(project, ".env"), "PRIVATE_KEY=env-value");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial fixture");
  return { project, git };
}

