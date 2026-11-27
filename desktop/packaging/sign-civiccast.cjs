// Windows signing hook for electron-builder (win.signtoolOptions.sign) and a CLI for files the build does not sign itself.
// Smart App Control blocks every unsigned exe and dll, so each one is signed, not only the installer.
// Signing goes through Scott's Azure Trusted Signing workflow in scottconverse/civiccast, one file per run.
// That workflow takes .exe names only; a dll is sent under an .exe name and renamed back (the signature does not depend on the name).
// Off unless RIGWELL_SIGN=civiccast, so ordinary and CI builds stay unsigned.
// Signed copies are kept by unsigned SHA-256 in RIGWELL_SIGN_CACHE, so unchanged files (Electron dlls, NSIS plugins) are signed once.
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SUBJECT = "CN=Scott Converse, O=Scott Converse,";
const enabled = () => process.env.RIGWELL_SIGN === "civiccast";
const cacheDir = () => process.env.RIGWELL_SIGN_CACHE || path.join(os.homedir(), ".rigwell-sign-cache");
const script = () => process.env.RIGWELL_SIGN_SCRIPT || path.join(__dirname, "sign-civiccast.ps1");
const version = () => require(path.join(__dirname, "..", "package.json")).version;
// Windows PowerShell 5.1 cannot load its own modules with a PowerShell 7 PSModulePath, so children start without it.
const psEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (k.toUpperCase() === "PSMODULEPATH") delete e[k]; return e; };
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function signature(file) {
  const ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:RW_FILE; [Console]::Write(\"$($s.Status)|$($s.SignerCertificate.Subject)|$([bool]$s.TimeStamperCertificate)\")";
  const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", env: psEnv({ RW_FILE: file }), windowsHide: true });
  const [status = "", subject = "", stamped = ""] = (r.stdout || "").split("|");
  return { status, subject, stamped: stamped === "True" };
}
const ours = (s) => s.status === "Valid" && s.subject.startsWith(SUBJECT) && s.stamped;

function signFile(file) {
  const before = signature(file);
  if (ours(before)) return console.log(`  sign: already signed ${path.basename(file)}`);
  // Keep a vendor's valid signature (bun, Microsoft dlls); Smart App Control accepts it.
  if (before.status === "Valid") return console.log(`  sign: keeping vendor signature on ${path.basename(file)} (${before.subject.split(",")[0]})`);
  const hash = sha256(file);
  const cached = path.join(cacheDir(), `${hash}.signed`);
  if (!fs.existsSync(cached)) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "rw-sign-"));
    const ext = path.extname(file).slice(1) || "bin";
    const intake = path.join(work, `${path.basename(file, path.extname(file))}-${ext}.exe`);
    fs.copyFileSync(file, intake);
    console.log(`  sign: sending ${path.basename(file)} to the civiccast signing workflow`);
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script(), "-Exe", intake, "-Project", "rigwell", "-Version", version(), "-OutDir", path.join(work, "out"), "-RemoveDraftAfter"], { stdio: "inherit", windowsHide: true, env: psEnv() });
    if (r.status !== 0) throw new Error(`Signing failed for ${file} (exit ${r.status})`);
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.copyFileSync(path.join(work, "out", path.basename(intake)), cached);
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.copyFileSync(cached, file);
  if (!ours(signature(file))) throw new Error(`Signed copy of ${file} is not valid`);
  console.log(`  sign: signed ${path.basename(file)}`);
}

module.exports = async function sign(config) {
  if (!enabled()) return;
  signFile(config.path);
};
module.exports.signFile = signFile;
module.exports.signature = signature;
module.exports.ours = ours;
module.exports.psEnv = psEnv;

if (require.main === module) {
  if (!enabled()) { console.error("Set RIGWELL_SIGN=civiccast to sign."); process.exit(1); }
  for (const file of process.argv.slice(2)) signFile(path.resolve(file));
}
