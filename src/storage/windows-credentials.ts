import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { CommandRunner, CredentialBackend } from "./credentials.ts";

// Fixed code only in argv. Account and secret travel as JSON over stdin, never shell text.
const BRIDGE = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RigwellCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$target='rigwell/'+$request.account
switch ($request.op) {
  'get' {
    $pointer=[IntPtr]::Zero
    if (![RigwellCredentials]::Read($target,1,0,[ref]$pointer)) { exit 1 }
    try {
      $credential=[Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][RigwellCredentials+Credential])
      $bytes=New-Object byte[] $credential.CredentialBlobSize
      if ($bytes.Length) { [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob,$bytes,0,$bytes.Length) }
      [Console]::Write([Convert]::ToBase64String($bytes))
    } finally { [RigwellCredentials]::CredFree($pointer) }
  }
  'set' {
    $bytes=[Text.Encoding]::UTF8.GetBytes($request.value)
    if ($bytes.Length -gt 2560) { exit 1 }
    $credential=New-Object RigwellCredentials+Credential
    $credential.Type=1; $credential.TargetName=$target; $credential.UserName='rigwell'; $credential.Persist=2
    $credential.CredentialBlobSize=$bytes.Length
    $credential.CredentialBlob=[Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max(1,$bytes.Length))
    try {
      if ($bytes.Length) { [Runtime.InteropServices.Marshal]::Copy($bytes,0,$credential.CredentialBlob,$bytes.Length) }
      if (![RigwellCredentials]::Write([ref]$credential,0)) { exit 1 }
    } finally {
      for ($i=0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($credential.CredentialBlob,$i,0) }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($credential.CredentialBlob)
      [Array]::Clear($bytes,0,$bytes.Length)
    }
  }
  'delete' { if (![RigwellCredentials]::Delete($target,1,0)) { exit 1 } }
  default { exit 1 }
}
`;

const powershell = () => join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const nativeRunner: CommandRunner = (cmd, input) => {
  try {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { input, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "" };
  } catch { return { code: 127, stdout: "" }; }
};

/** Windows Credential Manager, current user's generic credentials. No elevation or UI. */
export class WindowsCredentialBackend implements CredentialBackend {
  readonly name = "windows-credential-manager";
  constructor(private run: CommandRunner = nativeRunner, private has: () => boolean = () => process.platform === "win32" && existsSync(powershell())) {}
  available() { return this.has(); }
  private call(op: string, account: string, value?: string) {
    if (!account || account.includes("\0") || account.length > 2048) return { code: 1, stdout: "" };
    return this.run([powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", BRIDGE], JSON.stringify({ op, account, ...(value === undefined ? {} : { value }) }));
  }
  get(account: string) {
    const r = this.call("get", account);
    return r.code === 0 ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : undefined;
  }
  set(account: string, value: string) { return Buffer.byteLength(value, "utf8") <= 2560 && this.call("set", account, value).code === 0; }
  delete(account: string) { return this.call("delete", account).code === 0; }
}
