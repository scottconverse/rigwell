// Signed Windows build: bun run package:win:signed (Windows only; needs gh with access to scottconverse/civiccast and 7-Zip).
// Smart App Control blocks every unsigned exe and dll, including the NSIS plugin dlls inside the installer.
// electron-builder signs the app files and the installer through packaging/sign-civiccast.cjs, but it copies the
// NSIS plugins straight from its download cache. So this script fills a private cache, signs those plugins there,
// builds, and then opens the finished installer and checks the signature of every program file in it.
// The private cache keeps signed plugins out of the shared electron-builder cache used by other projects.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const desk = resolve(import.meta.dir, "..");
const signer = require("./sign-civiccast.cjs");

// The NSIS plugins the electron-builder installer template uses (checked again on the finished installer below).
const PLUGINS = { nsis: ["nsDialogs", "nsExec", "System"], "nsis-resources": ["nsis7z", "StdUtils", "UAC", "WinShell"] } as const;

function fail(message: string): never { console.error(`package-win-signed: ${message}`); process.exit(1); }
function run(cmd: string, args: string[], env: Record<string, string>, cwd = desk) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", windowsHide: true });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

if (process.platform !== "win32") fail("Windows only.");

// 1. The NSIS download names and checksums, read from the installed electron-builder so they cannot drift.
const nsisDir = join(desk, "node_modules", "app-builder-lib", "out", "targets", "nsis");
function artifact(file: string, name: "nsis" | "nsis-resources") {
  const m = readFileSync(join(nsisDir, file), "utf8").match(new RegExp(`getBinFromUrl\\)\\("${name}", "([^"]+)", "([^"]+)"\\)`));
  if (!m) fail(`cannot find the ${name} download in ${file}; electron-builder changed, update this script`);
  return { name, version: m[1], sha512: m[2], id: `${name}-${m[1]}` };
}
const artifacts = [artifact("nsisUtil.js", "nsis"), artifact("NsisTarget.js", "nsis-resources")];

const cache = resolve(process.env.ELECTRON_BUILDER_CACHE || join(homedir(), ".rigwell-sign-cache", "electron-builder"));
const shared = resolve(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache");
if (cache.toLowerCase() === shared.toLowerCase()) fail("ELECTRON_BUILDER_CACHE is the shared cache; use a private folder");
const env = {
  ELECTRON_BUILDER_CACHE: cache,
  SZA_PATH: require("7zip-bin").path7za,
  RIGWELL_SIGN: "civiccast",
  RIGWELL_TARGET_PLATFORM: "win32",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};
Object.assign(process.env, env);
console.log(`== cache ${cache}`);

// 2. Download (or reuse) both NSIS archives, then sign the plugins inside the cache.
const appBuilder: string = require("app-builder-bin").appBuilderPath;
for (const a of artifacts) {
  const dir = join(cache, "nsis", a.id);
  if (!existsSync(dir)) {
    const url = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${a.id}/${a.id}.7z`;
    run(appBuilder, ["download-artifact", "--name", a.id, "--url", url, "--sha512", a.sha512], env);
  }
  if (!existsSync(dir)) fail(`download of ${a.id} did not create ${dir}`);
  const pluginDir = join(dir, a.name === "nsis" ? "Plugins" : "plugins", "x86-unicode");
  for (const p of PLUGINS[a.name]) {
    const file = join(pluginDir, `${p}.dll`);
    if (!existsSync(file)) fail(`missing plugin ${file}`);
    signer.signFile(file);
  }
}

// 3. Build. The electron-builder hook signs the app exe and dll files, the uninstaller and the installer.
run(process.execPath, ["run", "build.ts"], env);
run(process.execPath, ["run", "packaging/stage.ts"], env);
run("node", [join(desk, "node_modules", "electron-builder", "cli.js"), "--config", "electron-builder.yml", "--win"], env);

// 4. The build must have used only the cache folders signed above.
const used = readdirSync(join(cache, "nsis")).sort();
const expected = artifacts.map((a) => a.id).sort();
if (used.join("|") !== expected.join("|")) fail(`NSIS cache holds ${used.join(", ")}; expected only ${expected.join(", ")}`);

// 5. Open the finished installer and check every program file in it.
const version = JSON.parse(readFileSync(join(desk, "package.json"), "utf8")).version;
const installer = join(desk, "release", `rigwell-setup-${version}-x64.exe`);
if (!existsSync(installer)) fail(`no installer at ${installer}`);
const sevenZip = [process.env.RIGWELL_7Z, "7z", join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe")]
  .filter((c): c is string => !!c).find((c) => spawnSync(c, ["i"], { windowsHide: true }).status === 0);
if (!sevenZip) fail("7-Zip (7z.exe) is needed to check the installer; install it or set RIGWELL_7Z");
const work = mkdtempSync(join(tmpdir(), "rw-check-"));
try {
  const quiet = (args: string[]) => { const r = spawnSync(sevenZip, args, { windowsHide: true }); if (r.status !== 0) fail(`7z ${args[0]} failed: ${r.stderr}`); };
  quiet(["x", installer, `-o${join(work, "nsis")}`, "-y"]);
  const appArchive = walk(join(work, "nsis")).find((f) => /app-64\.7z$/i.test(f));
  if (!appArchive) fail("no app-64.7z inside the installer");
  quiet(["x", appArchive, `-o${join(work, "app")}`, "-y"]);
  const pe = walk(work).filter(isPe);
  const list = join(work, "files.txt");
  writeFileSync(list, pe.join("\r\n"), "utf8");
  const ps = "Get-Content -LiteralPath $env:RW_LIST -Encoding UTF8 | % { $s = Get-AuthenticodeSignature -LiteralPath $_; \"$($s.Status)|$($s.SignerCertificate.Subject)|$_\" }";
  const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", env: signer.psEnv({ RW_LIST: list }), windowsHide: true, maxBuffer: 1 << 24 });
  const rows = (r.stdout || "").split(/\r?\n/).filter(Boolean).map((l) => { const [status, subject, file] = l.split("|"); return { status, subject: (subject ?? "").split(",")[0], file: (file ?? "").slice(work.length + 1) }; });
  for (const row of rows) console.log(`  ${row.status.padEnd(8)} ${row.subject.padEnd(22)} ${row.file}`);
  const bad = rows.filter((row) => row.status !== "Valid");
  if (rows.length !== pe.length || !pe.length) fail(`checked ${rows.length} of ${pe.length} program files`);
  if (bad.length) fail(`${bad.length} program files are not signed: ${bad.map((b) => b.file).join(", ")}`);
  if (!signer.ours(signer.signature(installer))) fail("the installer itself is not signed by Scott Converse with a timestamp");
  console.log(`== DONE ${installer}: installer and all ${rows.length} program files inside are signed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}
function isPe(file: string) {
  const fd = openSync(file, "r");
  try { const b = Buffer.alloc(2); return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x4d && b[1] === 0x5a; } finally { closeSync(fd); }
}
