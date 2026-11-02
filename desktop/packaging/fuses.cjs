// Electron fuses (spec 14.6), flipped at packaging time with @electron/fuses and read back by test/desktop/packaging.test.ts.
// Off: RunAsNode, NODE_OPTIONS, inspect arguments. On: cookie encryption, embedded asar integrity validation, only load app from asar.
const path = require("node:path");
const { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = require("@electron/fuses");

const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/** Expected state per fuse name, for tests. */
const EXPECTED = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableCookieEncryption: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};

/** The file (or .app bundle) that carries the fuse wire for a packed app folder. */
function executableFor(appOutDir, platform, productFilename, executableName) {
  if (platform === "darwin" || platform === "mas") return path.join(appOutDir, `${productFilename}.app`);
  if (platform === "win32") return path.join(appOutDir, `${productFilename}.exe`);
  return path.join(appOutDir, executableName);
}

/** electron-builder afterPack hook. */
async function afterPack(context) {
  const fs = require("node:fs");
  const staged = path.join(context.packager.getResourcesDir(context.appOutDir), "daemon", "node_modules_staged");
  if (fs.existsSync(staged)) fs.renameSync(staged, path.join(path.dirname(staged), "node_modules"));
  const info = context.packager;
  const exe = executableFor(context.appOutDir, context.electronPlatformName, info.appInfo.productFilename, info.executableName);
  await flipFuses(exe, FUSES);
}

/** Reads the fuse wire from a binary as { RunAsNode: false, ... } by option name. */
async function readFuses(exePath) {
  const wire = await getCurrentFuseWire(exePath);
  const out = {};
  for (const [name, idx] of Object.entries(FuseV1Options)) {
    if (typeof idx !== "number") continue;
    const v = wire[idx];
    // FuseState: ENABLE = 49 ('1'), DISABLE = 48 ('0'), REMOVED = 114 ('r')
    if (v !== undefined) out[name] = v === 49;
  }
  return out;
}

module.exports = { FUSES, EXPECTED, afterPack, readFuses, default: afterPack };
