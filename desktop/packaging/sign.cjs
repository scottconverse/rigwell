// Windows code signing hook for electron-builder (win.signtoolOptions.sign in electron-builder.yml).
// electron-builder calls it once for each .exe it packs. It signs only Rigwell's own files:
//   rigwell.exe (the app), __uninstaller-nsis-*.exe (the uninstaller) and rigwell-setup-*.exe (the setup file).
// It never signs resources/bun/bun.exe: that is the Bun runtime, already signed by its maker.
// Any other .exe stops the build, so nothing is signed by mistake and nothing new ships unsigned without notice.
//
// Signing is on only when RIGWELL_SIGN=1 (the release workflow sets it). Then it needs AZURE_TENANT_ID,
// AZURE_CLIENT_ID and AZURE_CLIENT_SECRET in the environment and the ArtifactSigning PowerShell module installed.
// Without RIGWELL_SIGN=1 the hook signs nothing, so local and CI builds stay unsigned.
const { execFileSync } = require("node:child_process");
// Windows path rules on every OS: they split on both \ and /, so the tests give the same answer on Linux CI.
const path = require("node:path").win32;

const AZURE = {
  endpoint: "https://wcus.codesigning.azure.net",
  account: "scottconverse-signing",
  profile: "ScottConversePublic",
  timestamp: "http://timestamp.acs.microsoft.com",
};
const SIGNER = "CN=Scott Converse";
const AZURE_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];

/** What to do with one file: "sign" (our own file), "skip" (third-party, already signed) or "unknown" (stop). */
function classify(file) {
  const name = path.basename(file).toLowerCase();
  const dir = path.basename(path.dirname(file)).toLowerCase();
  if (name === "bun.exe" && dir === "bun") return "skip";
  if (name === "rigwell.exe") return "sign";
  if (/^__uninstaller-nsis-[a-z0-9._-]+\.exe$/.test(name)) return "sign";
  if (/^rigwell-setup-[0-9][a-z0-9.+-]*-(x64|arm64|ia32)\.exe$/.test(name)) return "sign";
  return "unknown";
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function pwsh(command) {
  return execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function sign(configuration) {
  const file = configuration.path;
  const action = classify(file);
  if (action === "unknown") throw new Error(`sign.cjs: no signing rule for ${path.basename(file)}. Add a rule in desktop/packaging/sign.cjs.`);
  if (action === "skip") {
    console.log(`  • sign.cjs: skip ${path.basename(file)} (third-party, keeps its own signature)`);
    return;
  }
  if (process.env.RIGWELL_SIGN !== "1") {
    console.log(`  • sign.cjs: not signing ${path.basename(file)} (RIGWELL_SIGN is not 1)`);
    return;
  }
  const missing = AZURE_ENV.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`sign.cjs: RIGWELL_SIGN=1 but these are not set: ${missing.join(", ")}`);

  console.log(`  • sign.cjs: signing ${path.basename(file)}`);
  pwsh(
    [
      "$ErrorActionPreference = 'Stop'",
      "Import-Module ArtifactSigning",
      `Invoke-ArtifactSigning -Endpoint ${psQuote(AZURE.endpoint)} -CodeSigningAccountName ${psQuote(AZURE.account)}` +
        ` -CertificateProfileName ${psQuote(AZURE.profile)} -Files ${psQuote(file)} -FileDigest SHA256` +
        ` -TimestampRfc3161 ${psQuote(AZURE.timestamp)} -TimestampDigest SHA256`,
    ].join("; "),
  );
  // Fail closed: the file must now carry a valid signature from Scott's certificate.
  const out = pwsh(`$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`).trim();
  const [status, subject = ""] = out.split("|");
  if (status !== "Valid" || !subject.startsWith(SIGNER)) {
    throw new Error(`sign.cjs: ${path.basename(file)} is not validly signed after signing (status ${status}, signer ${subject || "none"})`);
  }
  console.log(`  • sign.cjs: ${path.basename(file)} is signed (Valid, ${subject})`);
}

module.exports = { sign, classify };
