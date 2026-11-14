import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function machineRuntimeInfo() {
  const root = join(import.meta.dir, "../.."), file = join(root, "remote-build.json");
  const metadata = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  return { pid: process.pid, platform: process.platform, arch: process.arch, runtime: Bun.version, version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, build: metadata?.build ?? null };
}
