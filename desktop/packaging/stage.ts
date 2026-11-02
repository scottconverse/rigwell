// Stages what the packaged app carries next to its asar (spec 14.5): the bun runtime and the daemon sources, so the app
// can start its own daemon with no outside install. Output: desktop/build/stage/{bun/bun,daemon/...}.
// Run with: bun run packaging/stage.ts   (from desktop/)
// RIGWELL_BUN_BIN points at the bun executable for the TARGET platform (cross builds); default is the running bun.
// RIGWELL_TARGET_PLATFORM=win32 names the staged runtime bun.exe.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const repo = join(desktop, "..");
const stage = join(desktop, "build", "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bun"), { recursive: true });

const win = (process.env.RIGWELL_TARGET_PLATFORM ?? process.platform) === "win32";
const bunSrc = process.env.RIGWELL_BUN_BIN ?? process.execPath;
if (!existsSync(bunSrc)) throw new Error(`bun executable not found: ${bunSrc}`);
const bunDest = join(stage, "bun", win ? "bun.exe" : "bun");
cpSync(bunSrc, bunDest);
if (!win) chmodSync(bunDest, 0o755);

// Daemon sources: src/ plus a package.json for module resolution and the runtime dependencies.
cpSync(join(repo, "src"), join(stage, "daemon", "src"), { recursive: true, filter: (p) => !/\.test\.ts$/.test(p) });
const rootPkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
writeFileSync(join(stage, "daemon", "package.json"), JSON.stringify({ name: "rigwell-daemon", version: rootPkg.version, type: "module", dependencies: rootPkg.dependencies }, null, 2) + "\n");
// Runtime node_modules (staged as node_modules_staged because electron-builder drops folders named node_modules from extraResources; the afterPack hook renames it): everything installed in the repo root except dev-only packages.
const DEV = new Set(["@types", "bun-types", "typescript", "undici-types", "csstype", ".bin", ".cache"]);
if (!existsSync(join(repo, "node_modules", "quickjs-emscripten"))) throw new Error('run "bun install" in the repo root first');
cpSync(join(repo, "node_modules"), join(stage, "daemon", "node_modules_staged"), { recursive: true, filter: (p) => !DEV.has(p.slice(join(repo, "node_modules").length + 1).split("/")[0]) });
console.log("staged", stage);
