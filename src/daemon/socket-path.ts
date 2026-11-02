// Where the daemon's Unix socket lives. Plain Node APIs only: the desktop supervisor imports this too.
//
// A Unix socket path has a size limit (104 bytes on macOS, 108 on Linux and Windows, including the end byte).
// A long RIGWELL_HOME (a deep temp folder, a long user name) goes over it, and the daemon then cannot listen.
// So: <home>/daemon.sock when it fits, else a short path in the temp folder named from a hash of the home path.
// The same home always gives the same path, so the daemon, the desktop app, the SDK and the CLI all agree.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Largest socket path we use, in bytes. 103 leaves room for the end byte on macOS (the smallest limit). */
export const MAX_SOCKET_PATH_BYTES = 103;

export function daemonSocketPath(home: string, tempDir: string = tmpdir()): string {
  const normal = join(home, "daemon.sock");
  if (Buffer.byteLength(normal, "utf8") <= MAX_SOCKET_PATH_BYTES) return normal;
  const id = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
  return join(tempDir, `rigwell-${id}.sock`);
}
