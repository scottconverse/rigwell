// Parsing and checking of protocol parameters that carry structure (spec 3.1.5).
import type { ContentBlock } from "../core/types.ts";
import { ErrorCodes, RpcError } from "../protocol/rpc.ts";
import type { OutputFormat } from "../agent/session.ts";

const bad = (msg: string): never => { throw new RpcError(ErrorCodes.INVALID_PARAMS, msg); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_B64 = 7 * 1024 * 1024;
const MAX_PDF_B64 = 44 * 1024 * 1024;
const MAX_TEXT_FILE = 1024 * 1024;

export function strList(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad(`${name} must be a list of strings`);
  return v as string[];
}

/** initialize_session / load_session tool id lists. */
export function toolIdsFrom(p: Record<string, unknown>) {
  const r = { restrict: strList(p.restrictToolIds, "restrictToolIds"), enabled: strList(p.enabledToolIds, "enabledToolIds"), disabled: strList(p.disabledToolIds, "disabledToolIds"), additional: strList(p.additionalToolIds, "additionalToolIds") };
  return Object.values(r).some((x) => x !== undefined) ? r : undefined;
}

/** tags: [{name, metadata?: Record<string,string>}]. */
export function tagsFrom(v: unknown): { name: string; metadata?: Record<string, string> }[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return bad("tags must be a list");
  return v.map((t, i) => {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim()) return bad(`tags[${i}].name is required`);
    if (t.metadata !== undefined && (!isObj(t.metadata) || !Object.values(t.metadata).every((x) => typeof x === "string"))) bad(`tags[${i}].metadata must map names to strings`);
    return { name: t.name, ...(t.metadata ? { metadata: t.metadata as Record<string, string> } : {}) };
  });
}

/** update_session_settings tool id lists: a list replaces the stored one, null clears it, absent leaves it. */
export function toolIdUpdates(p: Record<string, unknown>) {
  const r: Record<string, string[] | null | undefined> = {};
  let any = false;
  for (const [k, key] of [["restrict", "restrictToolIds"], ["enabled", "enabledToolIds"], ["disabled", "disabledToolIds"], ["additional", "additionalToolIds"]] as const) {
    if (p[key] === undefined) continue;
    r[k] = p[key] === null ? null : strList(p[key], key);
    any = true;
  }
  return any ? (r as { restrict?: string[] | null; enabled?: string[] | null; disabled?: string[] | null; additional?: string[] | null }) : undefined;
}

/** systemPrompt (string, or {type:"preset", preset, append}) with the deprecated systemPromptOverride string. */
export function systemPromptFrom(p: Record<string, unknown>): string | { type: "preset"; preset?: string; append?: string } | undefined {
  const v = p.systemPrompt ?? p.systemPromptOverride;
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() ? v : bad("systemPrompt must not be blank");
  if (isObj(v) && v.type === "preset") {
    if (v.append !== undefined && typeof v.append !== "string") bad("systemPrompt.append must be a string");
    if (typeof v.append === "string" && !v.append.trim()) bad("systemPrompt.append must not be blank");
    return { type: "preset", ...(typeof v.preset === "string" ? { preset: v.preset } : {}), ...(typeof v.append === "string" ? { append: v.append } : {}) };
  }
  return bad('systemPrompt must be a string or {type:"preset", preset, append}');
}

/** {type:"json_schema", schema: object}; null clears it; undefined leaves the default. The schema's contents are checked per turn. */
export function outputFormatFrom(v: unknown, name: string): OutputFormat | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isObj(v) || v.type !== "json_schema" || !isObj(v.schema)) return bad(`${name} must be {type:"json_schema", schema: object} or null`);
  return { type: "json_schema", schema: v.schema };
}

function imageFrom(x: Record<string, unknown>, at: string): ContentBlock {
  const src = isObj(x.source) ? x.source : x;
  const data = src.data;
  const mediaType = (src.mediaType ?? src.media_type) as unknown;
  if (typeof data !== "string" || !data) bad(`${at}: data is required`);
  if (typeof mediaType !== "string" || !IMAGE_TYPES.includes(mediaType)) bad(`${at}: mediaType must be one of ${IMAGE_TYPES.join(", ")}`);
  if ((data as string).length > MAX_IMAGE_B64) bad(`${at}: the image is over 5 MiB`);
  return { type: "image", mediaType: mediaType as string, data: data as string };
}

function fileFrom(x: Record<string, unknown>, at: string): ContentBlock {
  const name = typeof x.name === "string" ? x.name : undefined;
  if (x.mediaType === "application/pdf") {
    if (typeof x.data !== "string" || !x.data) return bad(`${at}: data (base64) is required`);
    if (x.data.length > MAX_PDF_B64) bad(`${at}: the PDF is over 32 MiB`);
    return { type: "document", mediaType: "application/pdf", data: x.data, ...(name ? { name } : {}) };
  }
  if (typeof x.mediaType === "string" && x.mediaType.startsWith("text/")) {
    if (typeof x.data !== "string") return bad(`${at}: data (the text) is required`);
    if (x.data.length > MAX_TEXT_FILE) bad(`${at}: the text file is over 1 MiB`);
    return { type: "text", text: `<file name="${name ?? "attachment.txt"}">\n${x.data}\n</file>` };
  }
  return bad(`${at}: files must be application/pdf (base64) or text/* (plain text)`);
}

export interface ParsedUserMessage {
  text: string;
  content?: ContentBlock[];
  placement?: "end_of_turn" | "end_of_loop";
  outputFormat?: OutputFormat | null;
}

/** add_user_message: text, or content[], plus images[] and files[]. */
export function userMessageFrom(p: Record<string, unknown>): ParsedUserMessage {
  const blocks: ContentBlock[] = [];
  let rich = false;
  if (p.content !== undefined) {
    if (!Array.isArray(p.content) || p.content.length < 1) bad("content must be a non-empty list");
    (p.content as unknown[]).forEach((c, i) => {
      if (!isObj(c)) return bad(`content[${i}] must be an object`);
      if (c.type === "text" && typeof c.text === "string") blocks.push({ type: "text", text: c.text });
      else if (c.type === "image") blocks.push(imageFrom(c, `content[${i}]`));
      else bad(`content[${i}] must be a text or image block`);
    });
    rich = true;
  } else {
    if (typeof p.text !== "string" || !p.text.trim()) bad("text is required");
    blocks.push({ type: "text", text: p.text as string });
  }
  if (p.images !== undefined) {
    if (!Array.isArray(p.images)) bad("images must be a list");
    (p.images as unknown[]).forEach((x, i) => { blocks.push(imageFrom(isObj(x) ? x : bad(`images[${i}] must be an object`) as never, `images[${i}]`)); rich = true; });
  }
  if (p.files !== undefined) {
    if (!Array.isArray(p.files)) bad("files must be a list");
    (p.files as unknown[]).forEach((x, i) => { blocks.push(fileFrom(isObj(x) ? x : bad(`files[${i}] must be an object`) as never, `files[${i}]`)); rich = true; });
  }
  const text = blocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n");
  if (p.queuePlacement !== undefined && p.queuePlacement !== "end_of_turn" && p.queuePlacement !== "end_of_loop") bad("queuePlacement must be end_of_turn or end_of_loop");
  if (!text.trim() && !blocks.some((b) => b.type !== "text")) bad("the message is empty");
  return {
    text: text || "(attachment)", ...(rich ? { content: blocks } : {}), ...(p.queuePlacement ? { placement: p.queuePlacement as "end_of_turn" | "end_of_loop" } : {}),
    ...(p.outputFormat !== undefined ? { outputFormat: outputFormatFrom(p.outputFormat, "outputFormat") } : {}),
  };
}
