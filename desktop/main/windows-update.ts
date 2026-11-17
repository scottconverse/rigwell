import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { WINDOWS_PUBLISHER } from "./release-config.ts";

// The path is data on stdin; only fixed code is passed to PowerShell.
const CHECK = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$signature=Get-AuthenticodeSignature -LiteralPath $request.path
@{status=[string]$signature.Status; subject=[string]$signature.SignerCertificate.Subject; timestamp=[string]$signature.TimeStamperCertificate.Subject} | ConvertTo-Json -Compress
`;
export type SignatureRunner = (command: string, args: string[], input: string) => { status: number | null; stdout: string; error?: unknown };
const nativeRunner: SignatureRunner = (command, args, input) => {
  // A PowerShell 7 parent can export incompatible module paths into Windows PowerShell.
  // This verifier needs only the OS-shipped Security module.
  const result = spawnSync(command, args, { input, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PSModulePath: join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules") } });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
};

/** A missing verifier, invalid chain, wrong publisher or missing timestamp all refuse installation. */
export function verifyWindowsUpdate(path: string, run: SignatureRunner = nativeRunner): void {
  const command = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = run(command, ["-NoProfile", "-NonInteractive", "-Command", CHECK], JSON.stringify({ path }));
  if (result.error || result.status !== 0) throw new Error("Windows could not verify the update signature");
  let signature: { status?: string; subject?: string; timestamp?: string };
  try { signature = JSON.parse(result.stdout); } catch { throw new Error("Windows returned an invalid signature result"); }
  if (signature?.status !== "Valid" || signature.subject !== WINDOWS_PUBLISHER || !signature.timestamp?.trim()) throw new Error("The update requires a valid, timestamped signature from the Rigwell publisher");
}

export interface WindowsUpdateInstaller {
  autoInstallOnAppQuit: boolean;
  on(event: "update-downloaded", listener: (event: { downloadedFile: string }) => void): unknown;
  quitAndInstall(): void;
}
/** Gate cached and freshly downloaded updates alike, independently of library publisher defaults. */
export function guardWindowsInstallation(updater: WindowsUpdateInstaller, refused: (error: unknown) => void, verify = verifyWindowsUpdate): void {
  updater.autoInstallOnAppQuit = false;
  updater.on("update-downloaded", event => {
    try { verify(event.downloadedFile); updater.quitAndInstall(); } catch (error) { refused(error); }
  });
}
