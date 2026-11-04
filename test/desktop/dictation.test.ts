// Dictation backends: a fake local speech-to-text program, a fake remote endpoint, and the "not configured" paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, DEFAULT_DICTATION, dictationStatus, DictationError, splitCommand, transcribe, type DictationSettings } from "../../desktop/main/dictation.ts";

let dir: string, fakeStt: string, fakeWhisper: string;
const WAV = Buffer.from("RIFF....WAVEfmt fake audio bytes");
const cfg = (o: Partial<DictationSettings>): DictationSettings => ({ ...DEFAULT_DICTATION, ...o });

/** A fake speech-to-text "program": the current bun running a script. Works the same on POSIX and Windows. */
function fakeProgram(name: string, source: string): string {
  const script = join(dir, `${name}.js`);
  writeFileSync(script, source);
  return `"${process.execPath}" "${script}"`;
}

/** A launcher file named like the real program, so name based behaviour (whisper) and PATH lookup are exercised. */
function launcherFor(folder: string, name: string, script: string): string {
  mkdirSync(folder, { recursive: true });
  const win = process.platform === "win32";
  const file = join(folder, win ? `${name}.cmd` : name);
  writeFileSync(file, win ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rigwell-stt-"));
  // args: <flag> <wav>; prints a whisper style transcript
  fakeStt = fakeProgram("fake-stt", 'const fs = require("fs"); console.log("[00:00:00.000 --> 00:00:02.000]   heard " + fs.statSync(process.argv[3]).size + " bytes"); console.log("[BLANK_AUDIO]");');
  // mimics the Python CLI: writes <name>.txt into --output_dir and prints progress on stdout
  const script = join(dir, "whisper.js");
  writeFileSync(script, 'const fs = require("fs"), path = require("path"); const a = process.argv.slice(2); const wav = a[0]; const out = a[a.indexOf("--output_dir") + 1]; console.log("progress..."); fs.writeFileSync(path.join(out, path.basename(wav, ".wav") + ".txt"), "python style text\\n");');
  fakeWhisper = launcherFor(join(dir, "pybin"), "whisper", script);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("helpers", () => {
  test("splitCommand honors quotes and rejects an unclosed one", () => {
    expect(splitCommand(`whisper-cli -m "/my models/base.bin" -f {file} 'a b'`)).toEqual(["whisper-cli", "-m", "/my models/base.bin", "-f", "{file}", "a b"]);
    expect(splitCommand("  ")).toEqual([]);
    expect(() => splitCommand('x "y')).toThrow(/unclosed/);
  });
  test("cleanTranscript removes timestamps and markers", () => {
    expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  hello there\n[BLANK_AUDIO]\n\n(music)\n world")).toBe("hello there world");
  });
});

describe("local command backend", () => {
  test("{file} receives the audio and stdout is the transcript", async () => {
    expect(await transcribe(WAV, cfg({ backend: "command", command: `${fakeStt} -f {file}` }))).toBe(`heard ${WAV.length} bytes`);
  });
  test("the Python whisper CLI style (transcript in a file) works", async () => {
    expect(await transcribe(WAV, cfg({ backend: "command", command: `"${fakeWhisper}" {file}` }))).toBe("python style text");
  });
  test("temp audio is deleted afterwards", async () => {
    const seen = join(dir, "seen.txt");
    const spy = fakeProgram("spy", `require("fs").writeFileSync(${JSON.stringify(seen)}, process.argv[2]); console.log("ok");`);
    await transcribe(WAV, cfg({ backend: "command", command: `${spy} {file}` }));
    expect(await Bun.file(readFileSync(seen, "utf8").trim()).exists()).toBe(false);
  });
  test("missing program, failing program and silence give clear errors", async () => {
    await expect(transcribe(WAV, cfg({ backend: "command", command: join(dir, "nope") + " {file}" }))).rejects.toMatchObject({ code: "not-configured" });
    const bad = fakeProgram("bad", 'console.error("boom"); process.exit(3);');
    await expect(transcribe(WAV, cfg({ backend: "command", command: bad }))).rejects.toThrow(/boom/);
    const quiet = fakeProgram("quiet", 'console.log("[BLANK_AUDIO]");');
    await expect(transcribe(WAV, cfg({ backend: "command", command: quiet }))).rejects.toMatchObject({ code: "empty" });
  });
  test("an empty command without whisper-cli on PATH explains how to enable dictation", async () => {
    const e = await transcribe(WAV, cfg({ backend: "command" }), { env: { PATH: dir } }).catch((x) => x);
    expect(e).toBeInstanceOf(DictationError);
    expect(e.message).toContain("whisper.cpp");
  });
  test("whisper-cli on PATH is used with the model path", async () => {
    const args = join(dir, "args.txt");
    const script = join(dir, "whisper-cli.js");
    writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(args)}, process.argv.slice(2).join(" ")); console.log("spoken words");`);
    const bin = join(dir, "bin");
    launcherFor(bin, "whisper-cli", script); // POSIX: executable script. Windows: whisper-cli.cmd, found through PATHEXT.
    const env = { PATH: bin, Path: bin, PATHEXT: ".EXE;.CMD;.BAT", ComSpec: process.env.ComSpec };
    expect(await transcribe(WAV, cfg({ backend: "command", model: "/m/base.bin", language: "en" }), { env })).toBe("spoken words");
    const a = readFileSync(args, "utf8");
    expect(a).toContain("-m /m/base.bin");
    expect(a).toContain("-nt -np -l en");
    const noModel = await transcribe(WAV, cfg({ backend: "command" }), { env }).catch((x) => x);
    expect(noModel.message).toContain("model");
  });
});

describe("off and remote", () => {
  test("off: not configured, with the how-to text", async () => {
    await expect(transcribe(WAV, DEFAULT_DICTATION)).rejects.toMatchObject({ code: "not-configured" });
    expect(dictationStatus(DEFAULT_DICTATION, { PATH: "" })).toMatchObject({ ready: false, remote: false });
  });
  test("remote: multipart upload with a bearer token from the named environment variable", async () => {
    let seen: { auth: string | null; model: string; size: number } | undefined;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const f = await req.formData();
      seen = { auth: req.headers.get("authorization"), model: String(f.get("model")), size: (f.get("file") as File).size };
      return Response.json({ text: " remote words " });
    } });
    try {
      const s = cfg({ backend: "remote", remoteEndpoint: `http://127.0.0.1:${srv.port}/v1/audio/transcriptions`, remoteApiKeyEnv: "STT_KEY", model: "m1" });
      expect(await transcribe(WAV, s, { env: { STT_KEY: "tok" } })).toBe("remote words");
      expect(seen).toEqual({ auth: "Bearer tok", model: "m1", size: WAV.length });
      expect(dictationStatus(s)).toMatchObject({ ready: true, remote: true });
      await expect(transcribe(WAV, cfg({ backend: "remote", remoteEndpoint: "ftp://x" }))).rejects.toMatchObject({ code: "not-configured" });
    } finally { srv.stop(true); }
  });
});
