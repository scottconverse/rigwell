// Dictation backends: a fake local speech-to-text program, a fake remote endpoint, and the "not configured" paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscript, DEFAULT_DICTATION, dictationStatus, DictationError, splitCommand, transcribe, type DictationSettings } from "../../desktop/main/dictation.ts";

let dir: string, fakeStt: string, fakeWhisper: string;
const WAV = Buffer.from("RIFF....WAVEfmt fake audio bytes");
const cfg = (o: Partial<DictationSettings>): DictationSettings => ({ ...DEFAULT_DICTATION, ...o });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rigwell-stt-"));
  fakeStt = join(dir, "fake-stt");
  writeFileSync(fakeStt, '#!/bin/sh\n# args: <flag> <wav>; prints a whisper style transcript\necho "[00:00:00.000 --> 00:00:02.000]   heard $(wc -c < "$2") bytes"\necho "[BLANK_AUDIO]"\n');
  chmodSync(fakeStt, 0o755);
  // mimics the Python CLI: writes <name>.txt into --output_dir and prints progress on stdout
  fakeWhisper = join(dir, "whisper");
  writeFileSync(fakeWhisper, '#!/bin/sh\nwav="$1"; shift\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output_dir" ]; then out="$2"; fi; shift; done\necho progress...\necho "python style text" > "$out/$(basename "$wav" .wav).txt"\n');
  chmodSync(fakeWhisper, 0o755);
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
    expect(await transcribe(WAV, cfg({ backend: "command", command: `${fakeWhisper} {file}` }))).toBe("python style text");
  });
  test("temp audio is deleted afterwards", async () => {
    const seen = join(dir, "seen.txt");
    const spy = join(dir, "spy");
    writeFileSync(spy, `#!/bin/sh\necho "$1" > ${seen}\necho ok\n`);
    chmodSync(spy, 0o755);
    await transcribe(WAV, cfg({ backend: "command", command: `${spy} {file}` }));
    expect(await Bun.file(readFileSync(seen, "utf8").trim()).exists()).toBe(false);
  });
  test("missing program, failing program and silence give clear errors", async () => {
    await expect(transcribe(WAV, cfg({ backend: "command", command: join(dir, "nope") + " {file}" }))).rejects.toMatchObject({ code: "not-configured" });
    const bad = join(dir, "bad");
    writeFileSync(bad, "#!/bin/sh\necho boom >&2\nexit 3\n"); chmodSync(bad, 0o755);
    await expect(transcribe(WAV, cfg({ backend: "command", command: bad }))).rejects.toThrow(/boom/);
    const quiet = join(dir, "quiet");
    writeFileSync(quiet, "#!/bin/sh\necho '[BLANK_AUDIO]'\n"); chmodSync(quiet, 0o755);
    await expect(transcribe(WAV, cfg({ backend: "command", command: quiet }))).rejects.toMatchObject({ code: "empty" });
  });
  test("an empty command without whisper-cli on PATH explains how to enable dictation", async () => {
    const e = await transcribe(WAV, cfg({ backend: "command" }), { env: { PATH: dir } }).catch((x) => x);
    expect(e).toBeInstanceOf(DictationError);
    expect(e.message).toContain("whisper.cpp");
  });
  test("whisper-cli on PATH is used with the model path", async () => {
    const bin = join(dir, "bin"); Bun.spawnSync(["mkdir", "-p", bin]);
    const args = join(dir, "args.txt");
    writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\necho "$@" > ${args}\necho spoken words\n`); chmodSync(join(bin, "whisper-cli"), 0o755);
    expect(await transcribe(WAV, cfg({ backend: "command", model: "/m/base.bin", language: "en" }), { env: { PATH: bin } })).toBe("spoken words");
    const a = readFileSync(args, "utf8");
    expect(a).toContain("-m /m/base.bin");
    expect(a).toContain("-nt -np -l en");
    const noModel = await transcribe(WAV, cfg({ backend: "command" }), { env: { PATH: bin } }).catch((x) => x);
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
