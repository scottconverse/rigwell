import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { buildRemoteBundle } from "./bundle.ts";
import { MachineStore, type Machine, type RemotePlatform } from "./store.ts";
import { remoteCommand, runSsh, shellQuote, SshTransport, uploadSftp } from "./ssh.ts";
import { RpcClient } from "../sdk/client.ts";
import { remoteSocketPath } from "./endpoint.ts";

type Run = (machine: Machine, command: string, opts?: { input?: Uint8Array; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
const ps = (script: string) => `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64")}`;
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
export async function probeRemote(machine: Machine, run: Run = runSsh): Promise<{ platform: RemotePlatform; arch: "x64" | "arm64"; home: string }> {
  const unix = await run(machine, 'uname -s && uname -m && printf "%s\\n" "$HOME"');
  let values = unix.stdout.trim().split(/\r?\n/);
  let platform: RemotePlatform | undefined = values[0] === "Linux" ? "linux" : values[0] === "Darwin" ? "darwin" : undefined;
  if (unix.code !== 0 || !platform) {
    if (unix.code === 255) throw new Error(`SSH connection failed: ${unix.stderr}`);
    const windows = await run(machine, ps("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::WriteLine('win32');[Console]::WriteLine([Runtime.InteropServices.RuntimeInformation]::OSArchitecture);[Console]::WriteLine([Environment]::GetFolderPath('UserProfile'))"));
    if (windows.code !== 0) throw new Error(`Could not detect remote OS: ${windows.stderr || unix.stderr}`);
    values = windows.stdout.trim().split(/\r?\n/); platform = values[0] === "win32" ? "win32" : undefined;
  }
  const arch = /^(x86_64|AMD64|X64)$/i.test(values[1] ?? "") ? "x64" : /^(aarch64|arm64)$/i.test(values[1] ?? "") ? "arm64" : undefined;
  const home = values[2];
  if (!platform || !arch || !home || /[\r\n\0]/.test(home) || !(platform === "win32" ? win32 : posix).isAbsolute(home) || values.length !== 3) throw new Error("Unsupported remote platform, architecture or home directory");
  return { platform, arch, home };
}

export async function bootstrapMachine(name: string, opts: { store?: MachineStore; run?: Run; bundle?: typeof buildRemoteBundle; upload?: typeof uploadSftp } = {}): Promise<Machine> {
  const store = opts.store ?? new MachineStore(), original = store.get(name), run = opts.run ?? runSsh;
  const probe = await probeRemote(original, run), paths = probe.platform === "win32" ? win32 : posix;
  const bundle = await (opts.bundle ?? buildRemoteBundle)({ platform: probe.platform, arch: probe.arch });
  const parent = paths.join(probe.home, ".rigwell", "remote"), root = paths.join(parent, bundle.build.slice(0, 16));
  if (Buffer.byteLength(remoteSocketPath(root, bundle.build, probe.platform)) >= 104) throw new Error("Remote home path is too long for the daemon socket");
  const stage = paths.join(parent, `incoming-${crypto.randomUUID()}`), archive = paths.join(stage, "build.tar"), unpacked = paths.join(stage, "build");
  const m: Machine = { ...original, platform: probe.platform };
  const checked = async (command: string, input?: Uint8Array) => {
    const result = await run(m, command, { input, timeoutMs: input ? 120_000 : 30_000 });
    if (result.code !== 0) throw new Error(`Remote bootstrap failed: ${result.stderr || result.stdout}`);
    return result;
  };
  let launcher = unpacked;
  if (probe.platform === "win32") {
    const parents = [paths.join(probe.home, ".rigwell"), parent];
    await checked(ps(parents.map((p) => `$p=${literal(p)};if(Test-Path -LiteralPath $p){if((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked remote installation directory'}}else{New-Item -ItemType Directory -Path $p|Out-Null};`).join("") + `$p=${literal(stage)};if(Test-Path -LiteralPath $p){throw 'Remote staging collision'};New-Item -ItemType Directory -Path $p|Out-Null`));
    await (opts.upload ?? uploadSftp)(m, bundle.bytes, archive);
    const checksum = createHash("sha256").update(bundle.bytes).digest("hex");
    const verifyArchive = `$sha=[Security.Cryptography.SHA256]::Create();$f=[IO.File]::OpenRead(${literal(archive)});try{$hash=[BitConverter]::ToString($sha.ComputeHash($f)).Replace('-','')}finally{$f.Dispose();$sha.Dispose()};if($hash -ine ${literal(checksum)}){throw 'Remote archive hash mismatch'};`;
    // The archive hash authenticates the staged launcher. Publish a new tree with
    // a same-volume rename. If the destination already exists, run the freshly
    // extracted launcher and have it verify the existing tree before using it.
    const result = await checked(ps(verifyArchive + `$u=${literal(unpacked)};$r=${literal(root)};New-Item -ItemType Directory -Path $u|Out-Null;& tar.exe -xmf ${literal(archive)} -C $u;if($LASTEXITCODE -ne 0){throw 'Archive extraction failed'};if(!(Test-Path -LiteralPath $r)){try{[IO.Directory]::Move($u,$r);'installed';exit 0}catch [IO.IOException]{if(!(Test-Path -LiteralPath $r)){throw}}};$item=Get-Item -LiteralPath $r -Force;if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid existing remote build'};'existing'`));
    const installation = result.stdout.trim();
    if (installation === "installed") launcher = root;
    else if (installation !== "existing") throw new Error("Remote bootstrap returned invalid installation status");
  } else {
    await checked(`umask 077; test ! -L ${shellQuote(paths.join(probe.home, ".rigwell"))} && test ! -L ${shellQuote(parent)} && mkdir -p ${shellQuote(parent)} && mkdir ${shellQuote(stage)} && cat > ${shellQuote(archive)}`, bundle.bytes);
    await checked(`mkdir ${shellQuote(unpacked)} && tar -xf ${shellQuote(archive)} -C ${shellQuote(unpacked)} && chmod 700 ${shellQuote(paths.join(unpacked, "bun"))} && test ! -L ${shellQuote(root)} && if test ! -e ${shellQuote(root)}; then cp -R ${shellQuote(unpacked)} ${shellQuote(root)}; fi`);
  }
  const runtime = paths.join(root, probe.platform === "win32" ? "bun.exe" : "bun");
  // The copied launcher verifies every file, then connects to or starts this exact build.
  const started = await checked(remoteCommand(m, [paths.join(launcher, probe.platform === "win32" ? "bun.exe" : "bun"), paths.join(launcher, "src/machines/remote-start.ts"), root, bundle.build]));
  let info: { build?: string; version?: string; pid?: number };
  try { info = JSON.parse(started.stdout.trim()); } catch { throw new Error("Remote bootstrap returned invalid build information"); }
  if (info.build !== bundle.build || info.version !== bundle.version) throw new Error("Remote daemon does not match the copied build");
  const saved = store.save({ ...m, root, build: bundle.build, version: bundle.version, ...(info.pid ? { daemonPid: info.pid } : {}), bootstrappedAt: new Date().toISOString() }, true);
  // Validate this exact owned staging target again before recursive cleanup. The verified
  // final runtime lives outside it, so Windows has no active executable handle in the target.
  const cleanup = `const fs=require('node:fs'),p=require('node:path');const target=${JSON.stringify(stage)},parent=${JSON.stringify(parent)};if(p.dirname(target)!==parent||!/^incoming-[a-f0-9-]{36}$/.test(p.basename(target))||fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==p.join(fs.realpathSync(parent),p.basename(target)))throw Error('Unsafe staging cleanup');fs.rmSync(target,{recursive:true});`;
  try { await checked(remoteCommand(m, [runtime, "-e", cleanup])); }
  catch (e) { throw new Error(`Machine ${name} is verified and recorded, but staging cleanup failed at ${stage}: ${(e as Error).message}`); }
  return saved;
}

export async function connectMachine(name: string, opts: { store?: MachineStore; executable?: string[]; log?: (text: string) => void } = {}) {
  const m = (opts.store ?? new MachineStore()).get(name);
  if (!m.root || !m.build || !m.platform) throw new Error("Bootstrap the machine before opening a session");
  const paths = m.platform === "win32" ? win32 : posix;
  const transport = new SshTransport(m, remoteCommand(m, [paths.join(m.root, m.platform === "win32" ? "bun.exe" : "bun"), paths.join(m.root, "src/cli/main.ts"), "daemon", "--stdio", "--socket", remoteSocketPath(m.root, m.build, m.platform)]), { executable: opts.executable, onStderr: opts.log });
  const client = new RpcClient(transport);
  try {
    const info = await client.request<{ build: string }>("machine_runtime_info");
    if (info.build !== m.build) throw new Error("Remote daemon build changed; bootstrap it again");
    return client;
  } catch (e) { await client.close(); throw e; }
}
