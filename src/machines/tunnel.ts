// SSH direct-tcpip channels preserve host configuration while disabling all configured forwards.
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { sshArgs } from "./ssh.ts";
import type { Machine } from "./store.ts";

export function remotePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Remote port must be between 1 and 65535");
  return value;
}

export function openSshStream(machine: Machine, port: number, executable = ["ssh"]) {
  const child = spawn(executable[0]!, [...executable.slice(1), ...sshArgs(machine), "-o", "ClearAllForwardings=yes", "-W", `127.0.0.1:${remotePort(port)}`, machine.host], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", ended = false;
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", (s: string) => { stderr = (stderr + s).slice(-4000); });
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => { ended = true; resolve(); });
    child.once("close", () => { ended = true; resolve(); });
  });
  return {
    child, closed, error: () => stderr,
    async close() {
      if (ended) return closed;
      child.stdin.destroy(); child.kill();
      const timer = setTimeout(() => { if (!ended) child.kill("SIGKILL"); }, 2000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

export async function openBrowserTunnel(machine: Machine, port: number, executable?: string[]) {
  remotePort(port);
  const streams = new Set<ReturnType<typeof openSshStream>>(), sockets = new Set<Socket>();
  let closing = false;
  const server = createServer((socket) => {
    if (closing || streams.size >= 32) { socket.destroy(); return; }
    const stream = openSshStream(machine, port, executable);
    streams.add(stream); sockets.add(socket);
    socket.on("error", () => socket.destroy());
    stream.child.stdout.pipe(socket); socket.pipe(stream.child.stdin);
    stream.child.once("error", () => socket.destroy());
    void stream.closed.then(() => { socket.destroy(); streams.delete(stream); });
    socket.once("close", () => { sockets.delete(socket); void stream.close(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Tunnel listener has no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      if (closing) return;
      closing = true;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...streams].map((s) => s.close())); await stopped;
    },
  };
}
