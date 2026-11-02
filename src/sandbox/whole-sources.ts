// Source text of the two small programs of the whole-process sandbox (see whole.ts). They are written to the private
// control directory at start, so the mode works from a source checkout and from a packaged build alike. Plain JavaScript,
// run with bun; no imports beyond node: built-ins.

/** Runs INSIDE the sandbox. Listens on the control socket; one connection = one command (or one hello). */
export const WORKER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
const [sock, hash] = process.argv.slice(2);
try { fs.unlinkSync(sock); } catch {}
const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
const server = net.createServer((c) => {
  let buf = "";
  let child = null;
  let sent = false;
  const send = (o) => { if (!c.destroyed) c.write(JSON.stringify(o) + "\n"); };
  const finish = (o) => { if (sent) return; sent = true; send(o); c.end(); };
  c.on("data", (d) => {
    if (child) return;
    buf += d.toString();
    const i = buf.indexOf("\n");
    if (i < 0) return;
    let req;
    try { req = JSON.parse(buf.slice(0, i)); } catch { return finish({ t: "x", error: "bad request" }); }
    if (req.t === "hello") return finish({ t: "hello", policyHash: hash, pid: process.pid });
    if (req.t !== "run") return finish({ t: "x", error: "unknown request" });
    child = spawn(req.shell, ["-c", req.command], { cwd: req.cwd, env: req.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => send({ t: "o", d: b.toString("base64") }));
    child.stderr.on("data", (b) => send({ t: "e", d: b.toString("base64") }));
    child.on("error", (e) => finish({ t: "x", error: e.message }));
    child.on("exit", (code, signal) => {
      // pipes can stay open when a background child inherited them: do not wait for them forever
      setTimeout(() => finish({ t: "x", code, signal }), 300);
    });
    child.on("close", (code, signal) => finish({ t: "x", code, signal }));
  });
  // the client went away (Execute timed out or was cancelled and killed it): kill the whole command
  c.on("close", () => { if (child && child.exitCode === null && child.signalCode === null) killGroup(child); });
  c.on("error", () => {});
});
server.listen(sock, () => { process.stdout.write(JSON.stringify({ t: "ready", policyHash: hash, pid: process.pid }) + "\n"); });
`;

/** Runs on the HOST, one per command. Relays a command to the worker and mirrors its output and exit status. */
export const CLIENT_SOURCE = String.raw`
import * as net from "node:net";
const [sock, cwd, shell, command] = process.argv.slice(2);
const c = net.connect(sock);
let buf = "";
let done = false;
const quit = (code, signal) => {
  done = true;
  process.stdout.write("", () => process.stderr.write("", () => {
    if (signal) { try { process.kill(process.pid, signal); } catch {} }
    process.exit(code);
  }));
};
c.on("connect", () => c.write(JSON.stringify({ t: "run", cwd, shell, command, env: process.env }) + "\n"));
c.on("data", (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.t === "o") process.stdout.write(Buffer.from(m.d, "base64"));
    else if (m.t === "e") process.stderr.write(Buffer.from(m.d, "base64"));
    else if (m.t === "x") {
      if (m.error) { process.stderr.write("sandbox: " + m.error + "\n"); return quit(126); }
      return quit(m.signal ? 128 : (m.code ?? 1), m.signal || undefined);
    }
  }
});
c.on("error", (e) => { process.stderr.write("sandbox worker unreachable: " + e.message + "\n"); process.exit(126); });
c.on("close", () => { if (!done) { process.stderr.write("sandbox worker closed the connection\n"); process.exit(125); } });
`;
