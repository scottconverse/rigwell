// Windows signing hook (desktop/packaging/sign.cjs): signs only Rigwell's own files, skips the Bun runtime,
// stops on any other .exe, and never signs unless RIGWELL_SIGN=1 with the Azure values set.
import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

const hook = createRequire(import.meta.url)(join(import.meta.dir, "../../desktop/packaging/sign.cjs"));
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["RIGWELL_SIGN", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("sign hook: which files", () => {
  test("signs the app, the uninstaller and the setup file", () => {
    expect(hook.classify("C:\\b\\release\\win-unpacked\\rigwell.exe")).toBe("sign");
    expect(hook.classify("C:\\b\\release\\__uninstaller-nsis-rigwell.exe")).toBe("sign");
    expect(hook.classify("C:\\b\\release\\rigwell-setup-0.3.3-x64.exe")).toBe("sign");
    expect(hook.classify("/b/release/rigwell-setup-1.0.0-beta.1-arm64.exe")).toBe("sign");
  });
  test("skips the bundled Bun runtime", () => {
    expect(hook.classify("C:\\b\\release\\win-unpacked\\resources\\bun\\bun.exe")).toBe("skip");
  });
  test("any other exe is unknown", () => {
    for (const f of ["C:\\x\\elevate.exe", "C:\\x\\electron.exe", "C:\\x\\resources\\daemon\\bun.exe", "C:\\x\\rigwell-setup.exe"]) {
      expect(hook.classify(f)).toBe("unknown");
    }
  });
});

describe("sign hook: when it signs", () => {
  test("an unknown exe stops the build", async () => {
    await expect(hook.sign({ path: "C:\\x\\elevate.exe" })).rejects.toThrow("no signing rule");
  });
  test("without RIGWELL_SIGN=1 it signs nothing and does not fail", async () => {
    delete process.env.RIGWELL_SIGN;
    await expect(hook.sign({ path: "C:\\b\\win-unpacked\\rigwell.exe" })).resolves.toBeUndefined();
  });
  test("with RIGWELL_SIGN=1 it fails if an Azure value is missing, and names only the missing keys", async () => {
    process.env.RIGWELL_SIGN = "1";
    process.env.AZURE_TENANT_ID = "t";
    process.env.AZURE_CLIENT_ID = "c";
    delete process.env.AZURE_CLIENT_SECRET;
    await expect(hook.sign({ path: "C:\\b\\win-unpacked\\rigwell.exe" })).rejects.toThrow("these are not set: AZURE_CLIENT_SECRET");
  });
});
