// SSH itself is fake: run the generated remote commands against an isolated local fixture.
// This exercises the real archive, shell quoting, copied runtime and owned daemon, headlessly.
import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tmpEnv, writeJson } from "../storage/helpers.ts";
import { bootstrapMachine } from "../../src/machines/bootstrap.ts";
import { buildRemoteBundle } from "../../src/machines/bundle.ts";
import { MachineStore } from "../../src/machines/store.ts";
import { SocketTransport } from "../../src/sdk/transport.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import { remoteSocketPath } from "../../src/machines/endpoint.ts";
import { createConnection } from "../../src/daemon/connection.ts";
import { SshTransport } from "../../src/machines/ssh.ts";
import type { Transport } from "../../src/sdk/transport.ts";
import { fileURLToPath } from "node:url";
import { closeSessionIndexes } from "../../src/storage/session-list.ts";

test("generated bootstrap installs and starts a verified build, preserving daemon discovery and remote Files", async () => {
  const env = tmpEnv(), base = process.platform === "win32" ? tmpdir() : "/tmp", home = mkdtempSync(join(base, "rw-")), store = new MachineStore();
  writeFileSync(join(home, "fixture.txt"), "initial");
  const discovery = join(env.rigwellHome, "daemon.json");
  writeJson(discovery, { pid: 123, fixture: "preserve" });
  const fake = await startFakeAnthropic([{ hang: true }]);
  const remoteHome = join(home, "state"), remoteDiscovery = join(remoteHome, "daemon.json");
  writeJson(remoteDiscovery, { pid: 456, fixture: "remote-preserve" });
  writeJson(join(remoteHome, "settings.json"), { customModels: [{ provider: "anthropic", model: "fake", displayName: "Fixture", baseUrl: fake.url, apiKey: "fake-key" }] });
  store.save({ name: "fixture", host: "owner@fake" });
  let root: string | undefined, build: string | undefined, pid: number | undefined;
  let calls = 0;
  try {
    const machine = await bootstrapMachine("fixture", { store,
      bundle: async (opts) => { const result = await buildRemoteBundle(opts); build = result.build; root = join(home, ".rigwell/remote", build.slice(0, 16)); return result; },
      run: async (_m, command, opts) => {
        calls++;
        if (calls === 1) return process.platform === "win32" ? { code: 1, stdout: "", stderr: "fixture: no uname" } : { code: 0, stdout: `${process.platform === "darwin" ? "Darwin" : "Linux"}\n${process.arch === "arm64" ? "arm64" : "x86_64"}\n${home}\n`, stderr: "" };
        if (process.platform === "win32" && calls === 2) return { code: 0, stdout: `win32\n${process.arch}\n${home}\n`, stderr: "" };
        const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
        const child = spawn(encoded ? "powershell.exe" : "sh", encoded ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] : ["-c", command], { env: { ...process.env, RIGWELL_HOME: remoteHome }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", (s) => stdout += s); child.stderr.setEncoding("utf8").on("data", (s) => stderr += s);
        child.stdin.on("error", () => {});
        const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        child.stdin.end(opts?.input);
        const code = await closed;
        try { const info = JSON.parse(stdout.trim()); if (info.build === build && typeof info.pid === "number") pid = info.pid; } catch {}
        return { code, stdout, stderr };
      },
    });
    expect(machine.build).toBe(build!); expect(machine.daemonPid).toBe(pid!);
    const socketPath = remoteSocketPath(root!, build!, process.platform as "win32" | "linux" | "darwin");
    const channel = join(home, "fixture-ssh-channel.ts");
    const stdio = fileURLToPath(new URL("../../src/machines/stdio.ts", import.meta.url));
    writeFileSync(channel, `import {bridgeDaemonStdio} from ${JSON.stringify(stdio)};await bridgeDaemonStdio(${JSON.stringify(socketPath)});`);
    const wire: Transport = { onMessage() {}, onClose() {}, write(line) { local.peer.feed(line + "\n"); }, async close() { await local.shutdown(); wire.onClose(); } };
    const local = createConnection((line) => queueMicrotask(() => wire.onMessage(line.trim())), { canPrompt: true,
      connectMachine: async (name) => { expect(name).toBe("fixture"); return new RpcClient(new SshTransport(machine, "fixture-command", { executable: [process.execPath, channel] })); },
    });
    const client = new RpcClient(wire);
    client.onRequest = () => ({ selectedOption: "proceed_once", trust: false });
    let terminalData = "";
    client.onNotification = (_method, params) => { const n = params.notification; if (n?.type === "daemon.terminal_data") terminalData += n.data; };
    try {
      await client.request("initialize_session", { machine: "fixture", cwd: home, modelId: "custom:Fixture-0", autonomyLevel: "low" });
      expect(local.session).toBeUndefined();
      const info = await client.request<{ build: string; pid: number }>("machine_runtime_info");
      expect(info.build).toBe(build!); expect(info.pid).toBe(pid!);
      await client.request("daemon.write_workspace_file_content", { filePath: "fixture.txt", content: "remote file" });
      const result = await client.request<{ content: string }>("daemon.get_workspace_file_content", { filePath: "fixture.txt" });
      expect(result.content).toBe("remote file");
      expect(await client.request("daemon.create_terminal", { terminalId: "routed", cwd: home })).toMatchObject({ success: true });
      await client.request("daemon.write_terminal_data", { terminalId: "routed", data: process.platform === "win32" ? "set RIGWELL_FIXTURE=42\r\necho routed-%RIGWELL_FIXTURE%\r\n" : "echo routed-$((6*7))\n" });
      const deadline = Date.now() + 3000;
      while (!terminalData.includes("routed-42")) { if (Date.now() >= deadline) throw new Error("Routed remote terminal did not return evaluated shell output"); await Bun.sleep(10); }
      expect(terminalData).toContain("routed-42");
      expect((await client.request<{ terminals: { id: string }[] }>("daemon.list_terminals")).terminals[0]?.id).toBe("routed");
      await client.request("daemon.close_terminal", { terminalId: "routed" });
      await client.request("add_user_message", { text: "Wait for the fleet stop fixture" });
      const started = Date.now();
      while (!fake.requests.length) { if (Date.now() - started > 3000) throw new Error("Fleet fixture did not enter its fake provider"); await Bun.sleep(10); }
      expect((await client.request("machine_runtime_info")).runningSessions).toBe(1);
      let busy: unknown;
      try { await client.request("machine_shutdown", { build }); } catch (error) { busy = error; }
      expect(String(busy)).toContain("Stop all running sessions");
      expect(await client.request("machine_stop_sessions")).toMatchObject({ runningSessions: 0 });
      const stopped = await client.request("owned_session_snapshot");
      expect(stopped.isAgentLoopInProgress).toBe(false);
      expect(stopped.messages.some((m: any) => m.role === "user")).toBe(true);
    } finally { await client.close(); }
    expect(await Bun.file(discovery).json()).toEqual({ pid: 123, fixture: "preserve" });
    expect(await Bun.file(remoteDiscovery).json()).toEqual({ pid: 456, fixture: "remote-preserve" });
  } finally {
    // Authenticate the exact freshly installed candidate over its owned socket before using its PID.
    if (pid && root && build) {
      const control = new RpcClient(await SocketTransport.connect(remoteSocketPath(root, build, process.platform as "win32" | "linux" | "darwin")));
      const info = await control.request<{ build: string; pid: number }>("machine_runtime_info");
      if (info.pid !== pid || info.build !== build || pid === process.pid) throw new Error("Owned daemon identity changed during cleanup");
      const closed = new Promise<void>((r) => { control.onClose = r; });
      let refusal: unknown;
      try { await control.request("machine_shutdown", { build: "f".repeat(64) }); } catch (e) { refusal = e; }
      expect(String(refusal)).toContain("different build");
      expect((await control.request("machine_runtime_info")).runningSessions).toBe(0);
      expect(await control.request("machine_stop_sessions")).toMatchObject({ runningSessions: 0 });
      const acknowledged = await control.request<{ shuttingDown: boolean }>("machine_shutdown", { build });
      expect(acknowledged).toEqual({ shuttingDown: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned daemon ${pid} did not stop; fixture preserved`)), 3000); })]); }
      finally { clearTimeout(timer); await control.close(); }
      const socket = remoteSocketPath(root, build, process.platform as "win32" | "linux" | "darwin");
      // An AF_UNIX reparse file may survive a failed earlier fixture shutdown.
      // The verified channel has closed before removing this owned socket file.
      if (existsSync(socket)) unlinkSync(socket);
    }
    fake.stop();
    if (!home.startsWith(join(base, "rw-"))) throw new Error("Unexpected fixture cleanup path");
    if (process.platform === "win32") {
      // Use the native filesystem implementation for the copied executable tree.
      // Bun's recursive rm returned EPERM here after the daemon and socket were gone.
      const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
      const cleanup = `$p=(Resolve-Path -LiteralPath ${literal(home)}).Path;if($p -ne ${literal(home)} -or !(Split-Path -Parent $p).Equals(${literal(base)},[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture cleanup'};Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop`;
      await new Promise<void>((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(cleanup, "utf16le").toString("base64")], { windowsHide: true }, (e) => e ? reject(e) : resolve()));
    } else await rm(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
    closeSessionIndexes(); env.cleanup();
  }
}, 20_000);
