import { expect } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { isPrivate } from "../src/platform/private.ts";
import path from "node:path";

/** Helpers that let tests run the same command on POSIX sh and Windows cmd.exe. */
export const isWin = process.platform === "win32";

let counter = 0;
/** Writes a JS file and returns a shell command that runs it with the current bun. Works in sh and cmd. */
export function jsCommand(dir: string, source: string, ...args: string[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cmd-${process.pid}-${counter++}.js`);
  writeFileSync(file, source);
  // Forward slashes work in sh, bash and cmd, and survive bash's backslash handling when the command goes through Execute.
  const fwd = (p: string) => p.replace(/\\/g, "/");
  return [`"${fwd(process.execPath)}"`, `"${fwd(file)}"`, ...args].join(" ");
}

/** A command that never finishes on its own (until `seconds`). */
export function sleepCommand(dir: string, seconds: number): string {
  return jsCommand(dir, `setTimeout(() => {}, ${seconds * 1000});`);
}

/** Compares two paths the way the platform does (case-insensitive and separator-agnostic on Windows). */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  return isWin ? n(a) === n(b) : path.resolve(a) === path.resolve(b);
}

/** Asserts a file is owner-only: exact mode 0600 on POSIX; on Windows the ACL has no entry for broad groups. */
export function expectOwnerOnly(file: string): void {
  if (!isWin) {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  // Windows has no mode bits. makePrivate() sets an owner-only ACL through icacls; verify what it enforced.
  expect(isPrivate(file)).not.toBe(false);
}
