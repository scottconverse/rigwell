// Ctrl+V image paste (spec 13.3): read an image from the system clipboard, or a file path to an image that sits there as text.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { PastedImage } from "./types.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The image type from its first bytes, or undefined when it is not PNG, JPEG, GIF or WebP. */
export function sniffImage(b: Uint8Array): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return undefined;
}

export function toPastedImage(bytes: Uint8Array): PastedImage | undefined {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return undefined;
  const mediaType = sniffImage(bytes);
  return mediaType ? { mediaType, data: Buffer.from(bytes).toString("base64") } : undefined;
}

export type Run = (cmd: string, args: string[]) => Buffer | undefined;

const defaultRun: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 3000 });
    return r.status === 0 && r.stdout?.length ? r.stdout : undefined;
  } catch { return undefined; }
};

/** Tries the platform's clipboard tools in turn. `run` is injectable for tests. */
export async function readClipboardImage(run: Run = defaultRun, platform: string = process.platform): Promise<PastedImage | undefined> {
  const tries: [string, string[]][] = platform === "darwin"
    ? [["pngpaste", ["-"]]]
    : [["wl-paste", ["--type", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]], ["xsel", ["--clipboard", "--output"]]];
  for (const [cmd, args] of tries) {
    const out = run(cmd, args);
    const img = out && toPastedImage(out);
    if (img) return img;
  }
  // A path copied as text (a file manager's Copy, or a dropped file name).
  const text = platform === "darwin" ? run("pbpaste", []) : (run("wl-paste", ["--no-newline"]) ?? run("xclip", ["-selection", "clipboard", "-o"]));
  const path = text?.toString("utf8").trim().replace(/^file:\/\//, "");
  if (path && !path.includes("\n") && /\.(png|jpe?g|gif|webp)$/i.test(path)) {
    try {
      if (statSync(path).size <= MAX_IMAGE_BYTES) return toPastedImage(readFileSync(path));
    } catch { /* not a readable file */ }
  }
  return undefined;
}
