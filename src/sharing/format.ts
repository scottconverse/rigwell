export const SHARE_MAX_BYTES = 10 * 1024 * 1024;
export interface SharedSession {
  schemaVersion: 1;
  title: string;
  exportedAt: string;
  messages: { role: "user" | "assistant"; text: string }[];
}
const marker = "RIGWELL-SHARE-V1";
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function assertSharedSize(text: string) { if (Buffer.byteLength(text) > SHARE_MAX_BYTES) throw new Error("Shared session exceeds the 10 MiB limit"); return text; }
export function renderSharedSession(value: SharedSession, format: "html" | "markdown") {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
  if (format === "html") return assertSharedSize(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(value.title)}</title><style>body{font:16px system-ui;max-width:900px;margin:2em auto;padding:1em}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #888;padding:1em 0}</style></head><body><h1>${escape(value.title)}</h1><p>Read-only session export. Attachments and private reasoning are omitted.</p>${value.messages.map((m) => `<article><h2>${m.role}</h2><pre>${escape(m.text)}</pre></article>`).join("")}<!--${marker}:${encoded}--></body></html>`);
  const messages = value.messages.map((m) => {
    const longest = Math.max(2, ...[...m.text.matchAll(/`+/g)].map((hit) => hit[0].length));
    const fence = "`".repeat(longest + 1);
    return `## ${m.role}\n\n${fence}\n${m.text}\n${fence}`;
  });
  const title = value.title.replace(/[\r\n]/g, " ").replace(/[<>]/g, "").replace(/([\\`*_{}\[\]()#+.!|])/g, "\\$1");
  return assertSharedSize(`# ${title}\n\nRead-only session export. Attachments and private reasoning are omitted.\n\n${messages.join("\n\n")}\n\n<!--${marker}:${encoded}-->\n`);
}
export function parseSharedSession(text: string): SharedSession {
  assertSharedSize(text);
  const match = new RegExp(`<!--${marker}:([A-Za-z0-9+/=]+)-->(?:</body></html>)?\\s*$`).exec(text);
  let parsed: any;
  try { parsed = JSON.parse(match ? Buffer.from(match[1]!, "base64").toString("utf8") : text); } catch { throw new Error("Not a supported Rigwell shared session"); }
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.title !== "string" || parsed.title.length > 10000 || typeof parsed.exportedAt !== "string" || !Number.isFinite(Date.parse(parsed.exportedAt)) || !Array.isArray(parsed.messages) || parsed.messages.length > 100000) throw new Error("Invalid shared session metadata");
  const messages = parsed.messages.map((m: any) => {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string") throw new Error("Invalid shared session message");
    return { role: m.role as "user" | "assistant", text: m.text };
  });
  return { schemaVersion: 1, title: parsed.title, exportedAt: parsed.exportedAt, messages };
}
