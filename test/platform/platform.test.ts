// Windows behavior, simulated on any platform through injectable platform/path arguments.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSpec, splitCommand, which } from "../../desktop/main/dictation.ts";
import { aclIsOwnerOnly, isPrivate, makePrivate } from "../../src/platform/private.ts";
import { shellInvocation } from "../../src/platform/shell.ts";
import { projectSlug } from "../../src/storage/paths.ts";
import { runHookCommandForTest } from "./hook-helper.ts";

const root = mkdtempSync(join(tmpdir(), "rigwell-plat-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("command shell (spec 5.6)", () => {
  test("Windows: %ComSpec% /d /s /c with the line passed verbatim inside one pair of quotes", () => {
    const inv = shellInvocation('echo "hi there" & exit 2', "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(inv.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", '"echo "hi there" & exit 2"']);
    expect(inv.windowsVerbatimArguments).toBe(true);
  });
  test("Windows without ComSpec falls back to System32\\cmd.exe", () => {
    expect(shellInvocation("dir", "win32", {}).file).toBe("C:\\Windows\\System32\\cmd.exe");
  });
  test("elsewhere: sh -c", () => {
    expect(shellInvocation("ls -l", "linux", {})).toEqual({ file: "sh", args: ["-c", "ls -l"], windowsVerbatimArguments: false });
    expect(shellInvocation("ls -l", "darwin", {}).file).toBe("sh");
  });
  test("a real hook-style command runs through the platform shell with stdin, an exit code and stderr", async () => {
    const r = await runHookCommandForTest(root);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim()).toBe("said-no");
    expect(r.stdout.trim()).toBe("seen:hello");
  });
});

describe("owner-only files", () => {
  test("icacls output with only the owner passes; broad groups fail", () => {
    const ok = "C:\\x\\credentials.json DESKTOP\\scott:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files";
    expect(aclIsOwnerOnly(ok)).toBe(true);
    for (const broad of ["BUILTIN\\Users:(R)", "Everyone:(R)", "NT AUTHORITY\\Authenticated Users:(M)"]) {
      expect(aclIsOwnerOnly(`C:\\x\\f ${broad}\r\n DESKTOP\\scott:(F)`)).toBe(false);
    }
  });
  test("a folder named Users in the path is not mistaken for the group", () => {
    expect(aclIsOwnerOnly("C:\\Users\\scott\\.rigwell\\credentials.json DESKTOP\\scott:(F)")).toBe(true);
  });
  test("POSIX: makePrivate sets 0600 and isPrivate sees it", () => {
    if (process.platform === "win32") return; // covered by the ACL tests above and the credential file tests
    const f = join(root, "secret.txt");
    writeFileSync(f, "x", { mode: 0o666 });
    expect(makePrivate(f)).toBe(true);
    expect(isPrivate(f)).toBe(true);
    writeFileSync(f, "x");
    require("node:fs").chmodSync(f, 0o644);
    expect(isPrivate(f)).toBe(false);
  });
  test("Windows without a user name cannot set an ACL and reports false instead of throwing", () => {
    const saved = process.env.USERNAME;
    delete process.env.USERNAME;
    try { expect(makePrivate(join(root, "nope"), { platform: "win32" })).toBe(false); } finally { if (saved !== undefined) process.env.USERNAME = saved; }
  });
});

describe("dictation command line (Windows)", () => {
  test("splitCommand keeps backslashes in quoted Windows paths; an escaped quote still works", () => {
    expect(splitCommand('"C:\\Program Files\\whisper\\whisper-cli.exe" -m C:\\m\\base.bin', "win32")).toEqual(["C:\\Program Files\\whisper\\whisper-cli.exe", "-m", "C:\\m\\base.bin"]);
    expect(splitCommand('say "a \\"b\\" c"', "win32")).toEqual(["say", 'a "b" c']);
    expect(splitCommand('say "a \\"b\\" c"', "linux")).toEqual(["say", 'a "b" c']);
    expect(splitCommand('x "C:\\a\\b"', "linux")).toEqual(["x", "C:ab"]); // POSIX rules are unchanged
  });
  test("launchSpec: .cmd and .bat go through cmd.exe with quoted arguments; .exe and POSIX start directly", () => {
    const l = launchSpec("C:\\bin\\whisper-cli.CMD", ["-m", "C:\\my models\\b.bin"], "win32", "C:\\Windows\\System32\\cmd.exe");
    expect(l).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/s", "/c", '""C:\\bin\\whisper-cli.CMD" "-m" "C:\\my models\\b.bin""'], verbatim: true });
    expect(launchSpec("C:\\bin\\w.exe", ["a"], "win32")).toEqual({ file: "C:\\bin\\w.exe", args: ["a"], verbatim: false });
    expect(launchSpec("/bin/w.cmd", ["a"], "linux")).toEqual({ file: "/bin/w.cmd", args: ["a"], verbatim: false });
  });
  test("which uses PATHEXT and the Path spelling on Windows", () => {
    const bin = join(root, "winbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "whisper-cli.CMD"), "@echo off\r\n");
    expect(which("whisper-cli", { Path: bin, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(bin, "whisper-cli.CMD"));
    expect(which("whisper-cli", { PATH: bin }, "win32")).toBe(join(bin, "whisper-cli.CMD")); // default PATHEXT
    expect(which("whisper-cli", { PATH: bin }, "linux")).toBeUndefined(); // no extension search on POSIX
  });
});

describe("project slug (spec 12.1) on Windows paths", () => {
  test("a Windows drive path read on another platform becomes -C-Users-scott", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(projectSlug("C:\\Users\\scott", platform)).toBe("-C-Users-scott");
      expect(projectSlug("C:/Users/scott/", platform)).toBe("-C-Users-scott");
      expect(projectSlug("D:\\work\\my.proj_1\\", platform)).toBe("-D-work-my.proj_1");
    }
  });
});
