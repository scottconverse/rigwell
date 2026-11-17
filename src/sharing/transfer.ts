import { lstatSync, readFileSync } from "node:fs";
import { codeProviderToken } from "../auth/code-providers.ts";
import { parseSharedSession, renderSharedSession, saveImportedSession, sharedSession, SHARE_MAX_BYTES, type SharedSession } from "./session.ts";

export interface ShareTransferDeps {
  fetch?: typeof fetch;
  token?: () => Promise<string | undefined>;
  /** Test-only endpoint seam, never accepted from protocol input. */
  apiRoot?: string;
  secrets?: string[];
}
async function responseText(response: Response) {
  if (!response.ok) throw new Error(`Share service returned HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > SHARE_MAX_BYTES) throw new Error("Shared session exceeds the 10 MiB limit");
  if (!response.body) throw new Error("Empty shared session response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > SHARE_MAX_BYTES) throw new Error("Shared session exceeds the 10 MiB limit"); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
const checkedUrl = (source: string) => {
  const url = new URL(source);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP(S) import URL without credentials or a fragment");
  return url;
};
export async function readSharedSource(source: string, deps: ShareTransferDeps = {}): Promise<SharedSession> {
  if (!source || source.includes("\0")) throw new Error("Shared session source is required");
  if (!/^https?:\/\//i.test(source)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw new Error("Unsupported import URL scheme");
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SHARE_MAX_BYTES) throw new Error("Import requires a regular file under 10 MiB");
    return parseSharedSession(readFileSync(source, "utf8"));
  }
  const url = checkedUrl(source), fetcher = deps.fetch ?? fetch;
  const get = async (url: URL | string) => responseText(await fetcher(checkedUrl(String(url)), { signal: AbortSignal.timeout(15_000), redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" }));
  if (url.hostname === "gist.github.com") {
    const id = url.pathname.split("/").filter(Boolean).at(-1);
    if (!id || !/^[a-f0-9]{5,64}$/i.test(id)) throw new Error("Invalid gist link");
    const gist = JSON.parse(await get(`${deps.apiRoot ?? "https://api.github.com"}/gists/${id}`));
    const file = gist.files?.["rigwell-session.md"] ?? gist.files?.["rigwell-session.html"];
    if (!file) throw new Error("Gist does not contain a Rigwell shared session");
    if (!file.truncated && typeof file.content === "string") return parseSharedSession(file.content);
    const raw = checkedUrl(file.raw_url);
    if (raw.protocol !== "https:" || raw.hostname !== "gist.githubusercontent.com") throw new Error("Invalid gist raw-file URL");
    return parseSharedSession(await get(raw));
  }
  return parseSharedSession(await get(url));
}
export async function importSharedSource(source: string, deps: ShareTransferDeps = {}) { return saveImportedSession(await readSharedSource(source, deps)); }

export async function shareSecretGist(id: string, approve: ((params: Record<string, unknown>) => Promise<any>) | undefined, deps: ShareTransferDeps = {}) {
  const value = sharedSession(id, { secrets: deps.secrets }), content = renderSharedSession(value, "markdown");
  if (!approve) throw new Error("Sharing requires an interactive user confirmation");
  const answer = await approve({ toolUses: [{ toolUse: { type: "tool_use", id: crypto.randomUUID(), name: "share_session", input: { sessionId: id } }, confirmationType: "share_session", details: { title: value.title, bytes: Buffer.byteLength(content), destination: "GitHub unlisted gist", warning: "Anyone with the link can read it. Review the redacted export before sharing." } }], options: [{ label: "Create unlisted gist", value: "proceed_once" }, { label: "Cancel", value: "cancel" }] });
  if (answer?.selectedOption !== "proceed_once") return { shared: false };
  const token = await (deps.token ?? (() => codeProviderToken("github")))();
  if (!token) throw new Error("Connect GitHub with gist permission, or export a file instead");
  const response = await (deps.fetch ?? fetch)(`${deps.apiRoot ?? "https://api.github.com"}/gists`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    body: JSON.stringify({ description: value.title, public: false, files: { "rigwell-session.md": { content } } }),
  });
  const result = JSON.parse(await responseText(response)), url = checkedUrl(result.html_url);
  if (url.protocol !== "https:" || url.hostname !== "gist.github.com") throw new Error("GitHub did not return a valid share link");
  return { shared: true, url: url.href };
}
