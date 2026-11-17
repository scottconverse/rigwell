import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { escapeHtml, renderMarkdown } from "../../desktop/renderer/lib/markdown.ts";
import { killProcessTree } from "../platform/shell.ts";
import { readWikiIndex, readWikiPage, wikiPath, withWikiLock } from "./wiki.ts";

export interface VideoTools { ffmpeg: string; speech: { kind: "windows" | "say" | "espeak"; command: string }; font: string }
const available = (command: string, args: string[]) => { const r = spawnSync(command, args, { windowsHide: true, stdio: "ignore", timeout: 5000 }); return !r.error && r.status === 0; };
export function localVideoTools(): { tools?: VideoTools; reason?: string } {
  if (!available("ffmpeg", ["-version"])) return { reason: "ffmpeg is not installed or not executable" };
  const font = process.platform === "win32" ? join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf") : process.platform === "darwin" ? "/System/Library/Fonts/Supplemental/Arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  if (!existsSync(font)) return { reason: "A supported local TrueType font was not found" };
  let speech: VideoTools["speech"] | undefined;
  if (process.platform === "win32" && available("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { if ($s.GetInstalledVoices().Count -eq 0) { exit 1 } } finally { $s.Dispose() }'])) speech = { kind: "windows", command: "powershell.exe" };
  else if (process.platform === "darwin" && available("/usr/bin/say", ["-v", "?"])) speech = { kind: "say", command: "/usr/bin/say" };
  else for (const command of ["espeak-ng", "espeak"]) if (available(command, ["--version"])) { speech = { kind: "espeak", command }; break; }
  return speech ? { tools: { ffmpeg: "ffmpeg", speech, font } } : { reason: "No supported local text-to-speech engine is installed" };
}
async function run(command: string, args: string[], cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    let error = "", timedOut = false; child.stderr.on("data", (b) => { error = (error + b).slice(-2000); });
    const stop = () => { if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000); signal?.addEventListener("abort", stop, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", (e) => { finish(); reject(e); });
    child.once("close", (code) => { finish(); code === 0 && !timedOut && !signal?.aborted ? resolve() : reject(new Error(signal?.aborted ? "Wiki video cancelled" : timedOut ? "Local video command exceeded two minutes" : `Local video command failed: ${error}`)); });
  });
}
function plain(text: string) { return text.replace(/```[\s\S]*?```/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`#*_<>]/g, "").replace(/\s+/g, " ").trim(); }
function wrap(text: string, width = 68) {
  const lines: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) { if (line.length + word.length > width) { lines.push(line); line = ""; } line += (line ? " " : "") + word; }
  if (line) lines.push(line); return lines.join("\n");
}
/** Offline HTML always works. Optional MP4 uses local synthesis to a file, never speakers or a cloud API. */
export async function wikiWalkthrough(cwd: string, options: { mp4?: boolean; tools?: VideoTools; signal?: AbortSignal; run?: typeof run } = {}) {
  return withWikiLock(cwd, async () => {
    const index = readWikiIndex(cwd); if (!index) throw new Error("Build the wiki first");
    const pages = index.pages.map((p) => ({ ...p, text: readWikiPage(cwd, p.file) }));
    const nav = pages.map((p, i) => `<li><a href="#page-${i}">${escapeHtml(p.title)}</a></li>`).join("");
    const body = pages.map((p, i) => `<section id="page-${i}">${renderMarkdown(p.text)}</section>`).join("\n");
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>Project wiki walkthrough</title><style>body{font:18px system-ui;max-width:1050px;margin:auto;padding:2rem;line-height:1.6}section{padding:2rem 0;border-top:1px solid #bbb}pre{overflow:auto;background:#eee;padding:1rem}a{color:#0756a8}</style><h1>Project wiki walkthrough</h1><p>Offline repository documentation. Follow the contents in order, then consult the cited source files. Mermaid source is included as text; the desktop Wiki renders its diagrams.</p><nav aria-label="Contents"><ol>${nav}</ol></nav>${body}</html>`;
    const htmlPath = wikiPath(cwd, "walkthrough.html"); writeFileSync(htmlPath, html, { mode: 0o600 });
    if (!options.mp4) return { html: htmlPath, video: undefined, reason: "MP4 not requested" };
    const detected = options.tools ? { tools: options.tools } : localVideoTools();
    if (!detected.tools) return { html: htmlPath, video: undefined, reason: detected.reason };
    const tools = detected.tools, execute = options.run ?? run, work = wikiPath(cwd, `video-${randomUUID()}`); mkdirSync(work);
    try {
      copyFileSync(tools.font, join(work, "font.ttf"));
      // Limit narration to eight selected pages. The HTML retains every page and source citation.
      const selected = pages.filter((p) => p.file !== "glossary.md").slice(0, 8), segments: string[] = [];
      for (let i = 0; i < selected.length; i++) {
        options.signal?.throwIfAborted(); const p = selected[i]!;
        const narration = `${p.title}. ${plain(p.text.replace(/^#.*\n/, "")).split(" ").slice(0, 90).join(" ")}`;
        writeFileSync(join(work, "narration.txt"), narration, "utf8"); writeFileSync(join(work, "slide.txt"), wrap(p.title + "\n\n" + narration.split(" ").slice(0, 85).join(" ")), "utf8");
        const audio = tools.speech.kind === "say" ? "narration.aiff" : "narration.wav";
        if (tools.speech.kind === "windows") {
          writeFileSync(join(work, "speak.ps1"), 'Add-Type -AssemblyName System.Speech\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\ntry { $s.SetOutputToWaveFile((Join-Path $PWD "narration.wav")); $s.Speak([IO.File]::ReadAllText((Join-Path $PWD "narration.txt"))) } finally { $s.Dispose() }\n');
          await execute(tools.speech.command, ["-NoProfile", "-NonInteractive", "-File", "speak.ps1"], work, options.signal);
        } else await execute(tools.speech.command, tools.speech.kind === "say" ? ["-f", "narration.txt", "-o", audio] : ["-f", "narration.txt", "-w", audio], work, options.signal);
        const segment = `slide-${i}.mp4`; segments.push(segment);
        await execute(tools.ffmpeg, ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x0f172a:s=1280x720:r=12", "-i", audio, "-vf", "drawtext=fontfile=font.ttf:textfile=slide.txt:expansion=none:fontcolor=white:fontsize=26:x=48:y=64", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", segment], work, options.signal);
      }
      writeFileSync(join(work, "segments.txt"), segments.map((s) => `file '${s}'`).join("\n"));
      await execute(tools.ffmpeg, ["-nostdin", "-y", "-v", "error", "-f", "concat", "-safe", "1", "-i", "segments.txt", "-c", "copy", "walkthrough.mp4"], work, options.signal);
      const video = wikiPath(cwd, "walkthrough.mp4"); copyFileSync(join(work, "walkthrough.mp4"), video);
      return { html: htmlPath, video, pages: selected.map((p) => p.file), reason: undefined };
    } finally { // Only the verified, uniquely owned working folder is removed.
      const checked = wikiPath(cwd, work.split(/[\\/]/).at(-1)!); rmSync(checked, { recursive: true, force: true });
    }
  });
}
