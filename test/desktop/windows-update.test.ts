import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { WINDOWS_PUBLISHER } from "../../desktop/main/release-config.ts";
import { guardWindowsInstallation, verifyWindowsUpdate } from "../../desktop/main/windows-update.ts";

test("Windows update signature verification fails closed and keeps the file path out of shell code", () => {
  const path = "C:\\updates\\a'$(unexpected).exe";
  verifyWindowsUpdate(path, (command, args, input) => {
    expect(command).toEndWith("powershell.exe"); expect(args.join(" ")).not.toContain(path); expect(JSON.parse(input)).toEqual({ path });
    return { status: 0, stdout: JSON.stringify({ status: "Valid", subject: WINDOWS_PUBLISHER, timestamp: "trusted timestamp" }) };
  });
  for (const result of [
    { status: 1, stdout: "" }, { status: null, stdout: "", error: new Error("missing verifier") },
    { status: 0, stdout: "bad JSON" }, { status: 0, stdout: "null" },
    ...["NotSigned", "HashMismatch", "UnknownError"].map(status => ({ status: 0, stdout: JSON.stringify({ status, subject: WINDOWS_PUBLISHER, timestamp: "timestamp" }) })),
    { status: 0, stdout: JSON.stringify({ status: "Valid", subject: "another publisher", timestamp: "timestamp" }) },
    { status: 0, stdout: JSON.stringify({ status: "Valid", subject: WINDOWS_PUBLISHER, timestamp: "" }) },
  ]) expect(() => verifyWindowsUpdate(path, () => result)).toThrow();
});

test("downloaded updates cannot install on quit or after signature refusal, including cached downloads", () => {
  const updater = Object.assign(new EventEmitter(), { autoInstallOnAppQuit: true, installs: 0, quitAndInstall() { this.installs++; } });
  const refused: unknown[] = [], verified: string[] = [];
  guardWindowsInstallation(updater, error => refused.push(error), file => { verified.push(file); if (file !== "valid.exe") throw new Error("signature refused"); });
  expect(updater.autoInstallOnAppQuit).toBe(false);
  updater.emit("update-downloaded", { downloadedFile: "cached-unsigned.exe" }); expect(updater.installs).toBe(0); expect(refused).toHaveLength(1);
  updater.emit("update-downloaded", { downloadedFile: "valid.exe" }); expect(updater.installs).toBe(1); expect(verified).toEqual(["cached-unsigned.exe", "valid.exe"]);
});
