// The SSH command connects to the remote daemon's local socket; it opens no remote TCP listener.
import { createConnection } from "node:net";
import { pipeline } from "node:stream/promises";
import type { Readable, Writable } from "node:stream";

export async function bridgeDaemonStdio(socketPath: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  try { await Promise.all([pipeline(input, socket), pipeline(socket, output)]); }
  finally { socket.destroy(); }
}
