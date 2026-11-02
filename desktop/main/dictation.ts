// Voice dictation backends (owner approved, spec 1 approval list). Offline first: the default is no backend, and the
// composer's microphone button then explains how to enable one. Audio never leaves the machine unless the user sets a
// remote endpoint themselves. No Electron imports: runs in the main process and under Bun in tests.
//
// Backends (desktop setting `dictation`):
//   off      nothing is configured (default).
//   command  a local speech-to-text program. `command` is the program and its arguments, split like a shell line (quotes
//            allowed, no shell is used). `{file}` is replaced by the path of a 16 kHz mono WAV file and `{dir}` by a
//            private temp folder. The transcript is the program's standard output. For the Python `whisper` CLI (which
//            writes files) Rigwell adds `--output_format txt --output_dir {dir}` and reads the .txt it writes.
//            When `command` is empty and `whisper-cli` (whisper.cpp) is on PATH, `whisper-cli -m <model> -f {file} -nt -np`
//            is used, with `model` as the path of a ggml model file.
//   remote   POST multipart (file, model, language) to an OpenAI-compatible `.../audio/transcriptions` endpoint the user
//            names. An optional bearer token is read from the environment variable named in `remoteApiKeyEnv`.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { existsSync, statSync } from "node:fs";

export interface DictationSettings {
  backend: "off" | "command" | "remote";
  command: string;
  /** ggml model path for whisper.cpp, or the model name for the `whisper` CLI and for a remote endpoint. */
  model: string;
  language: string;
  remoteEndpoint: string;
  remoteApiKeyEnv: string;
}
export const DEFAULT_DICTATION: DictationSettings = { backend: "off", command: "", model: "", language: "", remoteEndpoint: "", remoteApiKeyEnv: "" };

export class DictationError extends Error {
  constructor(message: string, readonly code: "not-configured" | "failed" | "empty") { super(message); }
}

export const HOW_TO_ENABLE =
  "Dictation needs a speech-to-text program on this computer. Install whisper.cpp (the whisper-cli program) and download a model, "
  + "then open Settings > Voice dictation, choose \"Local command\" and set the model path. Nothing is sent anywhere unless you choose a remote endpoint.";

/** Splits a command line into arguments: whitespace separates, single and double quotes group, backslash escapes inside double quotes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "", has = false, q: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (q) throw new DictationError("The dictation command has an unclosed quote.", "failed");
  if (has || cur) out.push(cur);
  return out;
}

/** Looks for a program on PATH. */
export function which(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return undefined;
}

export const KNOWN_PROGRAMS = ["whisper-cli", "whisper-cpp", "whisper"];
export function detectPrograms(env: Record<string, string | undefined> = process.env): string[] {
  return KNOWN_PROGRAMS.filter((n) => which(n, env));
}

/** The program and arguments for the command backend. */
export function commandLine(s: DictationSettings, env: Record<string, string | undefined> = process.env): string[] {
  let argv = s.command.trim() ? splitCommand(s.command) : [];
  if (!argv.length) {
    const found = ["whisper-cli", "whisper-cpp"].find((n) => which(n, env));
    if (!found) throw new DictationError(HOW_TO_ENABLE, "not-configured");
    if (!s.model.trim()) throw new DictationError("Set the path of the whisper.cpp model file in Settings > Voice dictation.", "not-configured");
    argv = [found, "-m", s.model.trim(), "-f", "{file}", "-nt", "-np"];
    if (s.language.trim()) argv.push("-l", s.language.trim());
  }
  return argv;
}

/** Transcript text without whisper's timestamp prefixes, blank lines and bracketed markers such as [BLANK_AUDIO]. */
export function cleanTranscript(raw: string): string {
  return raw.split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d{2}:\d{2}[:.\d]*\s*-->\s*[\d:.]+\]\s*/, "").trim())
    .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l) && !/^\(.*\)$/.test(l))
    .join(" ").replace(/\s+/g, " ").trim();
}

export interface TranscribeDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function run(file: string, args: string[], timeoutMs: number, env: Record<string, string | undefined>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: env as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new DictationError(`The dictation program "${file}" was not found. ${HOW_TO_ENABLE}`, "not-configured"));
        return reject(new DictationError(`The dictation program failed: ${String(stderr || err.message).trim().slice(-400)}`, "failed"));
      }
      resolve(stdout);
    });
  });
}

/** Turns WAV audio (16 kHz mono) into text with the configured backend. */
export async function transcribe(wav: Uint8Array, s: DictationSettings, deps: TranscribeDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const timeout = deps.timeoutMs ?? 120_000;
  if (s.backend === "off") throw new DictationError(HOW_TO_ENABLE, "not-configured");
  let text: string;
  if (s.backend === "remote") {
    let url: URL;
    try { url = new URL(s.remoteEndpoint); if (!/^https?:$/.test(url.protocol)) throw new Error("scheme"); } catch { throw new DictationError("The remote dictation endpoint is not a valid http(s) URL.", "not-configured"); }
    const form = new FormData();
    form.set("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "dictation.wav");
    form.set("model", s.model.trim() || "whisper-1");
    if (s.language.trim()) form.set("language", s.language.trim());
    const key = s.remoteApiKeyEnv ? env[s.remoteApiKeyEnv] : undefined;
    const res = await (deps.fetchFn ?? fetch)(url, { method: "POST", body: form, headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeout) })
      .catch((e) => { throw new DictationError(`The remote dictation endpoint could not be reached: ${(e as Error).message}`, "failed"); });
    if (!res.ok) throw new DictationError(`The remote dictation endpoint answered HTTP ${res.status}.`, "failed");
    const body = await res.text();
    try { const j = JSON.parse(body); text = typeof j.text === "string" ? j.text : ""; } catch { text = body; }
  } else {
    const argv = commandLine(s, env);
    const dir = mkdtempSync(join(tmpdir(), "rigwell-dictation-"));
    try {
      const file = join(dir, "dictation.wav");
      writeFileSync(file, wav);
      const sub = (a: string) => a.replaceAll("{file}", file).replaceAll("{dir}", dir);
      let args = argv.slice(1).map(sub);
      const prog = sub(argv[0]);
      const isPythonWhisper = basename(prog) === "whisper" && !argv.includes("--output_format");
      if (isPythonWhisper) {
        if (!args.includes(file)) args = [file, ...args];
        args.push("--output_format", "txt", "--output_dir", dir);
        if (s.model.trim() && !args.includes("--model")) args.push("--model", s.model.trim());
        if (s.language.trim() && !args.includes("--language")) args.push("--language", s.language.trim());
      }
      const out = await run(prog, args, timeout, env);
      text = isPythonWhisper ? readFileSync(join(dir, "dictation.txt"), "utf8") : out;
    } catch (e) {
      if (e instanceof DictationError) throw e;
      throw new DictationError(`The dictation program produced no transcript: ${(e as Error).message}`, "failed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const clean = cleanTranscript(text);
  if (!clean) throw new DictationError("No speech was recognized.", "empty");
  return clean;
}

/** What the settings page and the microphone button show. */
export function dictationStatus(s: DictationSettings, env: Record<string, string | undefined> = process.env): { ready: boolean; remote: boolean; detected: string[]; message: string } {
  const detected = detectPrograms(env);
  if (s.backend === "off") return { ready: false, remote: false, detected, message: HOW_TO_ENABLE };
  if (s.backend === "remote") {
    const ok = /^https?:\/\//.test(s.remoteEndpoint);
    return { ready: ok, remote: true, detected, message: ok ? `Audio is sent to ${new URL(s.remoteEndpoint).host}.` : "Set the remote endpoint URL in Settings > Voice dictation." };
  }
  try { commandLine(s, env); return { ready: true, remote: false, detected, message: "Speech is recognized on this computer." }; } catch (e) { return { ready: false, remote: false, detected, message: (e as Error).message }; }
}
