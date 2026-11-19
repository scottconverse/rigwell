import { execFile, spawn } from "node:child_process";
import { windowsArgument } from "./ssh.ts";
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const powershell = (script: string) => new Promise<string>((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => error ? reject(new Error(`Background daemon helper failed: ${stderr || error.message}`)) : resolve(stdout));
});
export interface DetachedDaemon { pid: number; exited(): Promise<boolean>; kill(): Promise<void> }
export async function launchDetachedDaemon(executable: string, args: string[]): Promise<DetachedDaemon> {
  if (process.platform === "win32") {
    let start: string;
    if (process.env.SSH_CONNECTION) {
      // OpenSSH tears down its job when the bootstrap channel closes. The local
      // process provider starts the daemon outside that job under the same user.
      const home = process.env.RIGWELL_HOME;
      const launchArgs = home ? ["-e", `process.env.RIGWELL_HOME=${JSON.stringify(home)};process.argv=${JSON.stringify([executable, ...args])};await import(${JSON.stringify(args[0]!.replaceAll("\\", "/"))});`] : args;
      const command = [executable, ...launchArgs].map(windowsArgument).join(" ");
      start = `$ProgressPreference='SilentlyContinue';$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0};$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${literal(command)};ProcessStartupInformation=$startup};if($created.ReturnValue -ne 0){throw ('Could not start daemon outside SSH job: '+$created.ReturnValue)};$p=Get-Process -Id $created.ProcessId;`;
    } else {
      start = `$p=Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(args.map(windowsArgument).join(" "))} -WindowStyle Hidden -PassThru;`;
    }
    const value = await powershell(start + "[Console]::WriteLine((@{pid=$p.Id;started=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress))");
    const info = JSON.parse(value);
    if (!Number.isSafeInteger(info.pid) || info.pid < 1 || !/^\d+$/.test(info.started)) throw new Error("Invalid owned daemon identity");
    const identify = `$p=Get-Process -Id ${info.pid} -ErrorAction SilentlyContinue;if(!$p){[Console]::WriteLine('exited');exit 0};if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne ${literal(info.started)} -or $p.MainModule.FileName -ine ${literal(executable)}){throw 'Owned daemon identity changed'};`;
    return { pid: info.pid, async exited() { return (await powershell(identify + "[Console]::WriteLine('running')")).trim() === "exited"; }, async kill() { await powershell(identify + "$p.Kill();$p.WaitForExit()"); } };
  }
  const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: "ignore" });
  let error: Error | undefined; child.once("error", (e) => { error = e; });
  const closed = new Promise<void>((r) => child.once("close", () => r())); child.unref();
  if (!child.pid) { await closed; throw error ?? new Error("Could not start remote daemon"); }
  return { pid: child.pid, async exited() { if (error) throw error; return child.exitCode !== null || child.signalCode !== null; }, async kill() { child.kill("SIGKILL"); await closed; } };
}
