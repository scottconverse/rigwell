// How the app starts its daemon (spec 14.1, 14.5). Plain functions, no Electron imports, so tests can call them.
import { posix, resolve, win32 } from "node:path";

export interface DaemonCmdInput {
  env: Record<string, string | undefined>;
  packaged: boolean;
  /** process.resourcesPath of a packaged app (holds bun/ and daemon/ staged by packaging/stage.ts). */
  resourcesPath?: string;
  /** Folder with package.json of the unpackaged app (desktop/). */
  appRoot: string;
  platform?: string;
}

export function daemonCommand(i: DaemonCmdInput): string[] {
  if (i.env.RIGWELL_DAEMON_CMD) return JSON.parse(i.env.RIGWELL_DAEMON_CMD);
  if (i.packaged && i.resourcesPath) {
    const win = (i.platform ?? process.platform) === "win32";
    const p = win ? win32 : posix; // the packaged layout follows the target platform's path rules
    return [p.join(i.resourcesPath, "bun", win ? "bun.exe" : "bun"), p.join(i.resourcesPath, "daemon", "src", "cli", "main.ts")];
  }
  return [i.env.RIGWELL_BUN ?? "bun", i.env.RIGWELL_CLI ?? resolve(i.appRoot, "..", "src", "cli", "main.ts")];
}
