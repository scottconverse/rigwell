import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { MachineStore, machineDefinition } from "../../src/machines/store.ts";
import { remoteCommand, shellQuote, sshArgs, SshTransport, windowsArgument } from "../../src/machines/ssh.ts";
import { RpcClient } from "../../src/sdk/client.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("machine definitions preserve only validated connection metadata and never replace implicitly", () => {
  const env = tmpEnv();
  try {
    const store = new MachineStore();
    store.save({ name: "build", host: "owner@build.example", port: 2222, knownHostsFile: join(env.root, "known hosts") });
    expect(store.get("build").port).toBe(2222);
    expect(() => store.save({ name: "build", host: "other" })).toThrow("already exists");
    for (const host of ["-oProxyCommand=bad", "owner@host;bad", "ssh://host", "host\nother"]) expect(() => machineDefinition({ name: "build", host })).toThrow();
    for (const name of ["local", "default", "../other", "bad name"]) expect(() => machineDefinition({ name, host: "host" })).toThrow();
    expect(machineDefinition({ name: "v6", host: "owner@[::1]", password: "not-persisted" })).toEqual({ name: "v6", host: "owner@[::1]" });
    expect(() => machineDefinition({ name: "bad", host: "host", port: 0 })).toThrow();
  } finally { env.cleanup(); }
});

test("SSH commands enforce host keys and preserve remote argument boundaries", () => {
  const m = { name: "build", host: "owner@host", platform: "linux" as const };
  const args = sshArgs(m);
  for (const setting of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "PermitLocalCommand=no"]) expect(args).toContain(setting);
  expect(remoteCommand(m, ["/a path/bun", "dollar$`quote'path"])).toBe("'/a path/bun' 'dollar$`quote'\\''path'");
  const command = remoteCommand({ ...m, platform: "win32" }, ["C:\\a path\\bun.exe", "a'$()`b"]);
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("FileName='C:\\a path\\bun.exe'");
  expect(script).toContain('Arguments=\'"a\'\'$()`b"\'');
  expect(script).toContain("CreateNoWindow=$true");
  expect(windowsArgument('path\\"quote\\')).toBe('"path\\\\\\"quote\\\\"');
  expect(shellQuote("x'y")).toBe("'x'\\''y'");
  expect(() => remoteCommand(m, ["bad\narg"])).toThrow();
});

test("SSH transport relays server requests and responses bidirectionally and owns its process", async () => {
  const env = tmpEnv();
  const script = join(env.root, "fake-ssh.ts");
  writeFileSync(script, `
    const args = process.argv.slice(2);
    if (!args.includes('StrictHostKeyChecking=yes') || !args.includes('ClearAllForwardings=yes')) process.exit(2);
    let pending = '';
    for await (const chunk of Bun.stdin.stream()) {
      pending += new TextDecoder().decode(chunk);
      let end;
      while ((end = pending.indexOf('\\n')) >= 0) {
        const m = JSON.parse(pending.slice(0,end)); pending = pending.slice(end+1);
        if (m.type === 'request') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',type:'request',id:'permission',method:'rigwell.request_permission',params:{original:m.id}})+'\\n');
        } else if (m.id === 'permission') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',type:'response',id:m.result.original,result:{answer:m.result.selectedOption}})+'\\n');
        }
      }
    }
  `);
  const transport = new SshTransport({ name: "fake", host: "owner@fake" }, "fake-command", { executable: [process.execPath, script] });
  const client = new RpcClient(transport);
  client.onRequest = (_method, params) => ({ selectedOption: "cancel", original: params.original });
  try { expect(await client.request<{ answer: string }>("initialize_session", {})).toEqual({ answer: "cancel" }); }
  finally { await client.close(); env.cleanup(); }
  expect(transport.process.exitCode).toBe(0);
}, 5000);

test("generated remote command preserves piped input, output and EOF through the native shell", async () => {
  const env = tmpEnv(), script = join(env.root, "echo input.ts");
  writeFileSync(script, `console.log(JSON.stringify({input:await Bun.stdin.text(),args:process.argv.slice(2)}));`);
  const platform = process.platform as "win32" | "linux" | "darwin";
  const command = remoteCommand({ name: "fixture", host: "fixture", platform }, [process.execPath, script, "quote' dollar$ backslash\\"]);
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
  const child = spawn(encoded ? "powershell.exe" : "sh", encoded ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] : ["-c", command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s) => stdout += s); child.stderr.setEncoding("utf8").on("data", (s) => stderr += s);
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    child.stdin.end("stream fixture\n");
    expect({ code: await closed, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ input: "stream fixture\n", args: ["quote' dollar$ backslash\\"] });
  } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill("SIGKILL"); await closed; } env.cleanup(); }
}, 5000);

test("SSH stdio bridge reaches the real daemon's session and Files methods without a TCP listener", async () => {
  const env = tmpEnv(), socket = join(env.root, "remote.sock");
  const daemon = await startDaemon({ socketPath: socket, ws: false, automations: false });
  const script = join(env.root, "fake-ssh-bridge.ts");
  writeFileSync(script, `import { bridgeDaemonStdio } from ${JSON.stringify(fileURLToPath(new URL("../../src/machines/stdio.ts", import.meta.url)))}; await bridgeDaemonStdio(process.argv[2]);`);
  const transport = new SshTransport({ name: "fake", host: "owner@fake" }, "fixture", { executable: [process.execPath, script, socket] });
  const client = new RpcClient(transport);
  try {
    expect(daemon.wsUrl).toBeUndefined(); expect(daemon.automations).toBeUndefined();
    const result = await client.request<{ models: unknown[] }>("list_models");
    expect(Array.isArray(result.models)).toBe(true);
    // An unknown session stays a protocol error, not an SSH failure or malformed stdout.
    let error: any;
    try { await client.request("daemon.list_files", { path: env.root }); } catch (e) { error = e; }
    expect(error?.code).toBe(-32005);
  } finally { await client.close(); await daemon.stop(); env.cleanup(); }
  expect(transport.process.exitCode).toBe(0);
}, 5000);
