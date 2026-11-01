// Terminal attention (spec §19.1, §19.3): BEL, sounds through an external player, OSC 9;4 progress, and the
// custom status line command (spec §13.1). Side effects live here so the reducer stays pure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SoundSettings {
  enableCompletionBell: boolean;
  completionSound: string;
  awaitingInputSound: string;
  soundVolume: number;
  soundFocusMode: "always" | "focused" | "unfocused";
}

/** Reads the sound keys from merged settings (spec §12.2 "Sounds", §19.3 defaults). */
export function soundSettings(s: Record<string, any>): SoundSettings {
  const g = (s.general && typeof s.general === "object" ? s.general : {}) as Record<string, any>;
  const pick = (k: string, d: unknown): any => s[k] ?? g[k] ?? d;
  const vol = Number(pick("soundVolume", 100));
  const mode = pick("soundFocusMode", "always");
  return {
    enableCompletionBell: pick("enableCompletionBell", false) === true,
    completionSound: String(pick("completionSound", "off")),
    awaitingInputSound: String(pick("awaitingInputSound", "ack")),
    soundVolume: Number.isFinite(vol) ? Math.min(100, Math.max(0, vol)) : 100,
    soundFocusMode: mode === "focused" || mode === "unfocused" ? mode : "always",
  };
}

/** Whether a sound should play given the focus mode and what the terminal reported (undefined = unknown, treated as focused). */
export function focusAllows(mode: SoundSettings["soundFocusMode"], focused: boolean | undefined): boolean {
  if (mode === "always") return true;
  return mode === "focused" ? focused !== false : focused === false;
}

/** OSC 9;4 progress (spec §19.2 says when it fires was not checked; rule: see decisions). 3 = indeterminate, 4 = paused, 0 = clear. */
export const progressSequence = (state: "working" | "waiting" | "idle") => `\x1b]9;4;${state === "working" ? 3 : state === "waiting" ? 4 : 0};\x07`;

// ---------------------------------------------------------------- built-in tones

/** 16-bit mono PCM WAV with a short decaying sine beep sequence. */
export function makeWav(freqs: number[], msEach: number, volume = 100, rate = 22050): Buffer {
  const per = Math.floor((rate * msEach) / 1000);
  const n = per * freqs.length;
  const data = Buffer.alloc(n * 2);
  const amp = 0.4 * 32767 * (volume / 100);
  freqs.forEach((f, k) => {
    for (let i = 0; i < per; i++) data.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * f * i) / rate) * (1 - i / per)), (k * per + i) * 2);
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Scales the samples of a 16-bit PCM WAV; null when the file is not one or is over 25 MB. */
export function scaleWav(buf: Buffer, volume: number): Buffer | null {
  if (buf.length > 25 * 1024 * 1024 || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, fmtOk = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmtOk = buf.readUInt16LE(off + 8) === 1 && buf.readUInt16LE(off + 22) === 16;
    if (id === "data") {
      if (!fmtOk) return null;
      const out = Buffer.from(buf);
      const end = Math.min(buf.length, off + 8 + size);
      for (let i = off + 8; i + 1 < end; i += 2) out.writeInt16LE(Math.round(buf.readInt16LE(i) * (volume / 100)), i);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

export const BUILTIN_SOUNDS: Record<string, { freqs: number[]; ms: number }> = {
  ack: { freqs: [660], ms: 120 },
  ok: { freqs: [660, 880], ms: 110 },
};

// ---------------------------------------------------------------- playback

export interface Player { cmd: string; args: (file: string, volume: number) => string[]; scales: boolean }

/** macOS afplay; Linux paplay, aplay, ffplay (in that order). */
export function findPlayer(platform = process.platform, which: (c: string) => string | null = (c) => Bun.which(c)): Player | null {
  if (platform === "darwin" && which("afplay")) return { cmd: "afplay", args: (f, v) => ["-v", String(v / 100), f], scales: true };
  if (platform === "linux") {
    if (which("paplay")) return { cmd: "paplay", args: (f, v) => [`--volume=${Math.round((v / 100) * 65536)}`, f], scales: true };
    if (which("aplay")) return { cmd: "aplay", args: (f) => ["-q", f], scales: false };
    if (which("ffplay")) return { cmd: "ffplay", args: (f, v) => ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(v), f], scales: true };
  }
  return null;
}

let tmp: string | undefined;
const tmpFile = (name: string) => join((tmp ??= mkdtempSync(join(tmpdir(), "rigwell-sound-"))), name);

export interface PlayDeps { bell: () => void; player?: Player | null; run?: (cmd: string, args: string[]) => Promise<boolean> }

const runPlayer = (cmd: string, args: string[]) =>
  new Promise<boolean>((res) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    const t = setTimeout(() => { p.kill(); res(false); }, 5000);
    p.on("error", () => { clearTimeout(t); res(false); });
    p.on("close", (c) => { clearTimeout(t); res(c === 0); });
  });

/** Plays one sound setting: off | bell | ack | ok | <file path>. Falls back to the bell, only at volume 100. */
export async function playSound(setting: string, volume: number, deps: PlayDeps): Promise<void> {
  const v = setting.trim();
  if (!v || v === "off") return;
  if (v === "bell") return deps.bell();
  const fallback = () => { if (volume >= 100) deps.bell(); };
  const player = deps.player === undefined ? findPlayer() : deps.player;
  if (!player) return fallback();
  let file: string;
  let vol = volume;
  try {
    if (BUILTIN_SOUNDS[v]) {
      const b = BUILTIN_SOUNDS[v];
      file = tmpFile(`${v}-${Math.round(volume)}.wav`);
      if (!existsSync(file)) writeFileSync(file, makeWav(b.freqs, b.ms, player.scales ? 100 : volume));
      if (!player.scales) vol = 100;
    } else {
      if (!existsSync(v) || !statSync(v).isFile()) return fallback();
      file = v;
      if (volume < 100 && !player.scales) {
        const scaled = scaleWav(readFileSync(v), volume);
        if (!scaled) return fallback();
        file = tmpFile(`custom-${Math.round(volume)}-${Math.abs(hash(v))}.wav`);
        writeFileSync(file, scaled);
        vol = 100;
      }
    }
  } catch { return fallback(); }
  const ok = await (deps.run ?? runPlayer)(player.cmd, player.args(file, vol));
  if (!ok) fallback();
}

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

// ---------------------------------------------------------------- custom status line

export interface StatusLineConfig { command: string; padding: number; maxRows: number }

/** Reads settings `statusLine: {type:"command", command, padding?, maxRows 1-3}`; null when not configured. */
export function statusLineConfig(s: Record<string, any>): StatusLineConfig | null {
  const c = s.statusLine;
  if (!c || typeof c !== "object" || c.type !== "command" || typeof c.command !== "string" || !c.command.trim()) return null;
  const rows = Math.round(Number(c.maxRows ?? 1));
  const pad = Math.round(Number(c.padding ?? 0));
  return { command: c.command, padding: Number.isFinite(pad) ? Math.min(20, Math.max(0, pad)) : 0, maxRows: Number.isFinite(rows) ? Math.min(3, Math.max(1, rows)) : 1 };
}

export const STATUS_LINE_TIMEOUT_MS = 2000;

/** What the status line command gets on stdin (the spec does not say; this shape is Rigwell's own). */
export interface StatusLineInput {
  session_id?: string; cwd: string; version: string;
  model: { id: string; display_name: string };
  mode: string; autonomy: string; reasoning: string; running: boolean;
  context: { used_tokens: number; limit_tokens: number; used_percent: number | null };
}

export type StatusLineResult = { ok: true; text: string } | { ok: false; hint: string };

export function runStatusLine(cfg: StatusLineConfig, input: StatusLineInput, cwd: string, timeoutMs = STATUS_LINE_TIMEOUT_MS): StatusLineResult {
  const r = spawnSync(process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "sh", ["-c", cfg.command], {
    cwd, input: JSON.stringify(input), timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024,
  });
  if (r.error) return { ok: false, hint: (r.error as any).code === "ETIMEDOUT" ? "Status line timed out. Run /statusline." : `Status line failed: ${r.error.message}. Run /statusline.` };
  if (r.status !== 0) return { ok: false, hint: `Status line exited ${r.status}. Run /statusline.` };
  const text = r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trimEnd()).filter((l, i, a) => l || i < a.length - 1).slice(0, cfg.maxRows).join("\n").trimEnd();
  return { ok: true, text };
}
