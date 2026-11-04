// FetchUrl: fetches a web page and returns it as text (spec 5.1 core set, 5.5.4: ask at Off, auto at Low and above).
import type { Tool } from "../core/types.ts";
import { fail, intArg, strArg } from "./util.ts";

export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_DEFAULT_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "..." };

/** HTML to readable text: scripts, styles and comments go, block tags become line breaks, entities are decoded. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    return label && !href.startsWith("#") && !href.startsWith("javascript:") ? `${label} (${href})` : label;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|ul|ol|table)\s*>/gi, "\n").replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  const body = s.split("\n").map((l) => l.replace(/[ \t\f\v]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return title ? `${title}\n\n${body}` : body;
}

export const FETCH_DESC =
  "Fetches a web page and returns its text.\n" +
  "- url: an http or https address. Web pages are turned into plain text (scripts and styles removed, links kept as `label (url)`); JSON and other text come back as they are.\n" +
  `- maxChars: how much text to return (default ${FETCH_DEFAULT_CHARS}). Longer pages are cut and say so.\n` +
  "- Responses over 2 MiB are cut. Binary content is refused. Redirects are followed.\n" +
  "- This reaches the network, so it asks for approval at autonomy off.";

export function createFetchUrlTool(): Tool {
  return {
    name: "FetchUrl",
    description: FETCH_DESC,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http or https address." },
        maxChars: { type: "integer", minimum: 200, description: `Characters to return. Default ${FETCH_DEFAULT_CHARS}.` },
      },
      required: ["url"],
      additionalProperties: false,
    },
    category: "other",
    async run(input, ctx) {
      const raw = strArg(input, "url");
      if (!raw) return fail("url is required.");
      let url: URL;
      try { url = new URL(raw); } catch { return fail(`Not a valid URL: ${raw}`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") return fail(`Only http and https addresses can be fetched, not ${url.protocol}`);
      const maxChars = Math.max(200, intArg(input, "maxChars") ?? FETCH_DEFAULT_CHARS);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      const onAbort = () => ac.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "rigwell-fetch/0.1", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (/^(image|audio|video)\//.test(type) || /(octet-stream|zip|pdf|font)/.test(type)) return fail(`${url} returned ${type}, which is not text.`);
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let cutBytes = false;
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
          if (size > FETCH_MAX_BYTES) { cutBytes = true; void reader.cancel(); break; }
        }
        const text = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, FETCH_MAX_BYTES);
        const isHtml = /html/.test(type) || (!type && /^\s*<(!doctype|html)/i.test(text));
        let out = isHtml ? htmlToText(text) : text;
        let note = "";
        if (out.length > maxChars) { note = `\n[Cut at ${maxChars} of ${out.length} characters. Ask for a larger maxChars if you need more.]`; out = out.slice(0, maxChars); }
        else if (cutBytes) note = `\n[The response was larger than ${FETCH_MAX_BYTES} bytes and was cut.]`;
        const head = `${url} (HTTP ${res.status}${type ? `, ${type.split(";")[0]}` : ""})\n\n`;
        if (res.status >= 400) return { content: `${head}${out}${note}`, isError: true };
        return { content: `${head}${out}${note}`, data: { url: String(url), status: res.status, contentType: type, text: out, truncated: !!note } };
      } catch (e) {
        if (ctx.signal.aborted) return fail("The fetch was stopped.");
        return fail(`Could not fetch ${url}: ${ac.signal.aborted ? `timed out after ${TIMEOUT_MS / 1000} seconds` : (e as Error)?.message ?? e}`);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
