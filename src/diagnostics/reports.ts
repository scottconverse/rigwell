import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { randomUUID } from "node:crypto";
import { configuredSecretValues, redactSharedText, redactSharedValue } from "../sharing/redact.ts";

export type CrashSource = "main" | "renderer" | "daemon";
const CRASH_NAME = /^(main|renderer|daemon)-[0-9]{13}-[0-9a-f-]{36}\.json$/;
const LOG_NAMES = ["main.log", "main.log.old", "daemon-stderr.log", "daemon-stderr.log.old", "daemon-critical-error.json"];
const MAX_FILE = 256 * 1024, MAX_CRASHES = 50;
const newestFirst = (a: string, b: string) => b.split("-")[1]!.localeCompare(a.split("-")[1]!);
const environmentSecrets = () => Object.entries(process.env).filter(([key, value]) => /(?:token|key|secret|password|authorization)/i.test(key) && value && value.length >= 4).map(([, v]) => v!);
export function redactDiagnosticText(text: string, values: string[] = []) { return redactSharedText(text, [...values, ...environmentSecrets()]); }
function directory(home: string, name: "logs" | "crashes", create = false) {
  const dir = join(home, name);
  try { const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Refusing linked or non-directory ${name}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; if (create) mkdirSync(dir, { recursive: true }); }
  return dir;
}
function regular(file: string) { const st = lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error("Refusing nonregular diagnostic file"); return st; }
export function recordCrash(home: string, source: CrashSource, kind: string, error: unknown) {
  try {
    const dir = directory(home, "crashes", true), now = Date.now();
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : typeof error === "string" ? error : JSON.stringify(error);
    const report = { schemaVersion: 1, source, kind: redactDiagnosticText(kind.slice(0, 100)), at: new Date(now).toISOString(), pid: process.pid, platform: process.platform, versions: { node: process.versions.node, bun: process.versions.bun, electron: process.versions.electron }, detail: redactDiagnosticText(String(detail).slice(0, 24000)) };
    const name = `${source}-${now}-${randomUUID()}.json`, file = join(dir, name); writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const older = [name, ...readdirSync(dir).filter((n) => n !== name && CRASH_NAME.test(n)).sort(newestFirst)];
    for (const name of older.slice(MAX_CRASHES)) { const path = join(dir, name); try { regular(path); unlinkSync(path); } catch {} }
    return file;
  } catch { return undefined; } // Reporting must never replace the original failure.
}
export function installProcessCrashCapture(home: string, source: "main" | "daemon") {
  const uncaught = (error: Error, origin: string) => { recordCrash(home, source, origin, error); };
  // Bun reports rejected promises without uncaughtExceptionMonitor. Match its fatal exit after recording.
  const rejection = (error: unknown) => { recordCrash(home, source, "unhandledRejection", error); process.exit(1); };
  process.on("uncaughtExceptionMonitor", uncaught); process.on("unhandledRejection", rejection);
  return () => { process.removeListener("uncaughtExceptionMonitor", uncaught); process.removeListener("unhandledRejection", rejection); };
}
export function appendDiagnosticLog(home: string, line: string) {
  try { const dir = directory(home, "logs", true), file = join(dir, "main.log"); let size = 0; try { size = regular(file).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } if (size > 1024 * 1024) { const old = file + ".old"; if (existsSync(old)) regular(old); renameSync(file, old); } appendFileSync(file, redactDiagnosticText(line).slice(0, 24000) + "\n", { mode: 0o600 }); } catch {}
}

// Stored ZIP entries, with platform zlib CRC32. No compressor, subprocess or external service is needed.
export function diagnosticZip(entries: { name: string; text: string }[]) {
  const chunks: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    if (!/^(?:[a-z0-9_-]+\/)?[a-zA-Z0-9_.-]+$/.test(entry.name) || entry.name.split("/").some((p) => p === "." || p === "..")) throw new Error("Invalid diagnostic ZIP entry");
    const name = Buffer.from(entry.name), body = Buffer.from(entry.text), crc = crc32(body), head = Buffer.alloc(30), dir = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(0x21, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(body.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    chunks.push(head, name, body); central.push(dir, name); offset += head.length + name.length + body.length;
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, table, end]);
}
export function buildDiagnosticBundle(home: string, versions: Record<string, string | undefined>, values = configuredSecretValues(home)) {
  const entries = [{ name: "versions.json", text: JSON.stringify({ ...versions, platform: process.platform, arch: process.arch }, null, 2) }], omitted: string[] = [];
  const add = (kind: "logs" | "crashes", names: string[]) => {
    let dir: string; try { dir = directory(home, kind); } catch { omitted.push(`${kind}: linked or unavailable`); return; }
    for (const name of names) {
      try {
        const file = join(dir, name), st = regular(file);
        let text: string;
        if (st.size > MAX_FILE) {
          if (name.endsWith(".json")) { omitted.push(`${kind}/${name}: exceeds ${MAX_FILE} bytes`); continue; }
          const fd = openSync(file, "r"), bytes = Buffer.alloc(MAX_FILE);
          try { const n = readSync(fd, bytes, 0, MAX_FILE, st.size - MAX_FILE); text = bytes.subarray(0, n).toString("utf8"); } finally { closeSync(fd); }
          const newline = text.indexOf("\n"); if (newline < 0) { omitted.push(`${kind}/${name}: line exceeds ${MAX_FILE} bytes`); continue; }
          text = "[Earlier log bytes omitted; bounded recent complete lines follow.]\n" + text.slice(newline + 1); omitted.push(`${kind}/${name}: earlier bytes omitted`);
        } else text = readFileSync(file, "utf8");
        if (name.endsWith(".json")) JSON.parse(text);
        entries.push({ name: `${kind}/${name}`, text });
      } catch { omitted.push(`${kind}/${name}: unavailable or nonregular`); }
    }
  };
  add("logs", LOG_NAMES);
  let names: string[] = []; try { names = readdirSync(directory(home, "crashes")).filter((n) => CRASH_NAME.test(n)).sort(newestFirst).slice(0, MAX_CRASHES); } catch {}
  add("crashes", names);
  entries.push({ name: "manifest.json", text: JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), files: entries.map((e) => e.name), omitted, coverage: "Local versions, allowlisted logs and up to 50 local crash reports. No sessions, settings, credentials, environment dump or native memory dumps. Known credentials, sensitive environment values and secret patterns are redacted. Review the archive before sending; redaction cannot identify every possible secret or private detail. No upload." }, null, 2) });
  const secrets = [...values, ...environmentSecrets()];
  const safe = entries.map((e) => ({ name: e.name, text: e.name.endsWith(".json") ? JSON.stringify(redactSharedValue(JSON.parse(e.text), secrets), null, 2) : redactDiagnosticText(e.text, values) }));
  return { bytes: diagnosticZip(safe), files: safe.map((e) => e.name), omitted };
}
