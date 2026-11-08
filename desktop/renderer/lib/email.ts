// Email drafts in assistant markdown: a fenced block with language `email` holds headers (To, Cc, Bcc, Subject, ...),
// a blank line, then the body. Pure parsing and the mailto: builder; the card itself is made in markdown.ts.

export interface EmailDraft {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string;
  /** All header lines in order, as written (name, value), for display. */
  headers: { name: string; value: string }[];
}

const addrs = (v: string) => v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);

/** Parse the inside of an ```email block. Returns null when it has no To or Subject header (so it stays a plain code block). */
export function parseEmail(text: string): EmailDraft | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const d: EmailDraft = { to: [], cc: [], bcc: [], subject: "", body: "", headers: [] };
  let i = 0;
  while (i < lines.length && !lines[i].trim() && d.headers.length === 0) i++;
  for (; i < lines.length; i++) {
    const m = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) break;
    const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const value = m[2].trim();
    d.headers.push({ name, value });
    if (name === "To") d.to.push(...addrs(value));
    else if (name === "Cc") d.cc.push(...addrs(value));
    else if (name === "Bcc") d.bcc.push(...addrs(value));
    else if (name === "Subject") d.subject = value;
  }
  if (!d.headers.some((h) => h.name === "To" || h.name === "Subject")) return null;
  while (i < lines.length && !lines[i].trim()) i++; // the blank separator (and any extra ones)
  d.body = lines.slice(i).join("\n").replace(/\s+$/, "");
  return d;
}

/** A mailto: URL. Subject, body, cc and bcc go through encodeURIComponent; line breaks in the body become CRLF as RFC 6068 asks. */
export function buildMailto(d: Pick<EmailDraft, "to" | "cc" | "bcc" | "subject" | "body">): string {
  const enc = (s: string) => encodeURIComponent(s);
  const list = (a: string[]) => a.map((x) => enc(x).replace(/%40/g, "@")).join(",");
  const q: string[] = [];
  if (d.cc.length) q.push(`cc=${list(d.cc)}`);
  if (d.bcc.length) q.push(`bcc=${list(d.bcc)}`);
  if (d.subject) q.push(`subject=${enc(d.subject)}`);
  if (d.body) q.push(`body=${enc(d.body.replace(/\r?\n/g, "\r\n"))}`);
  return `mailto:${list(d.to)}${q.length ? "?" + q.join("&") : ""}`;
}

/** Plain text of the draft, for the Copy button. */
export function emailPlainText(d: EmailDraft): string {
  const head = d.headers.map((h) => `${h.name}: ${h.value}`).join("\n");
  return d.body ? `${head}\n\n${d.body}` : head;
}
