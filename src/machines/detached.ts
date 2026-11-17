import { execFile, spawn } from "node:child_process";
import { windowsArgument } from "./ssh.ts";
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const powershell = (script: string) => new Promise<string>((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64")], { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => error ? reject(new Error(`Background daemon helper failed: ${stderr || error.message}`)) : resolve(stdout));
});
export interface DetachedDaemon { pid: number; exited(): Promise<boolean>; kill(): Promise<void> }
export async function launchDetachedDaemon(executable: string, args: string[]): Promise<DetachedDaemon> {
  if (process.platform === "win32") {
    // ShellExecute breaks inherited SSH pipe handles. Plain detached spawn on Windows
    // leaves unused ancestor handles open, preventing SSH stdout EOF after bootstrap.
    const value = await powershell(`$p=Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(args.map(windowsArgument).join(" "))} -WindowStyle Hidden -PassThru;[Console]::WriteLine(($p|ForEach-Object{@{pid=$_.Id;started=$_.StartTime.ToUniversalTime().Ticks.ToString()}}|ConvertTo-Json -Compress))`);
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
