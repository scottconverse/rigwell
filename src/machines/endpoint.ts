import { posix, win32 } from "node:path";
import type { RemotePlatform } from "./store.ts";
export function remoteSocketPath(root: string, build: string, platform: RemotePlatform): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(paths.resolve(root, "../../s"), `${build.slice(0, 16)}.sock`);
}
