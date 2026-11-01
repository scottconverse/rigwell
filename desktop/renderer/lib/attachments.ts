// Composer attachments (spec 14.3): files picked, pasted or dropped become images[] and files[] on add_user_message.
// Limits match the harness (src/daemon/params.ts): images 5 MiB, PDFs 32 MiB, text 1 MiB.

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_PDF = 32 * 1024 * 1024;
export const MAX_TEXT = 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export type AttachmentKind = "image" | "pdf" | "text";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mediaType: string;
  /** Base64 for images and PDFs, the text itself for text files. */
  data: string;
  size: number;
}

const EXT_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

/** What a file is, from its type and name; "text" is decided later by looking at the bytes when the type is unknown. */
export function classify(name: string, type: string): AttachmentKind | "unknown" {
  const t = type || EXT_TYPE[name.toLowerCase().split(".").pop() ?? ""] || "";
  if (IMAGE_TYPES.includes(t)) return "image";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("text/")) return "text";
  return "unknown";
}

export function base64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** True when the bytes look like UTF-8 text (no NUL in the first 8 KiB, decodes without errors). */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

export type Read = { ok: true; attachment: Attachment } | { ok: false; name: string; error: string };

let counter = 0;
/** Reads one File (or anything with name, type, size and arrayBuffer) into an attachment. */
export async function readAttachment(file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<Read> {
  const name = file.name || "pasted-image.png";
  let kind = classify(name, file.type);
  const limit = kind === "image" ? MAX_IMAGE : kind === "pdf" ? MAX_PDF : MAX_TEXT;
  if (file.size > limit) return { ok: false, name, error: `is over ${limit / 1048576} MiB` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let mediaType = file.type || EXT_TYPE[name.toLowerCase().split(".").pop() ?? ""] || "";
  if (kind === "unknown") {
    if (!looksLikeText(bytes)) return { ok: false, name, error: "is not an image, a PDF or a text file" };
    kind = "text";
    mediaType = "text/plain";
  }
  const id = `att-${++counter}`;
  if (kind === "text") return { ok: true, attachment: { id, name, kind, mediaType: mediaType.startsWith("text/") ? mediaType : "text/plain", data: new TextDecoder().decode(bytes), size: bytes.length } };
  return { ok: true, attachment: { id, name, kind, mediaType, data: base64Of(bytes), size: bytes.length } };
}

/** The add_user_message fields for these attachments. */
export function toParams(list: Attachment[]): { images?: { mediaType: string; data: string }[]; files?: { name: string; mediaType: string; data: string }[] } {
  const images = list.filter((a) => a.kind === "image").map((a) => ({ mediaType: a.mediaType, data: a.data }));
  const files = list.filter((a) => a.kind !== "image").map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }));
  return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}

/** Text to send when the user attached something but wrote nothing. */
export const defaultText = (list: Attachment[]) => `Attached: ${list.map((a) => a.name).join(", ")}`;

export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
