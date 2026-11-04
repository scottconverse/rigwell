// Update check against a static feed (spec 14.5). No Electron imports: runs in the main process and under Bun in tests.
//
// Feed format: the files electron-builder writes for its generic provider, so electron-updater can install from the same place.
//   <feed>/latest-linux.yml   Linux      <feed>/latest-mac.yml   macOS      <feed>/latest.yml   Windows
// A feed URL that ends in .yml, .yaml or .json is read as that one document instead (any platform).
// Fields used (YAML or JSON):
//   version: "1.4.0"                      required, semver
//   releaseDate: "2026-11-01T00:00:00Z"   optional
//   releaseNotes: "text"                  optional string
//   files: [{ url: "rigwell-1.4.0-x64.AppImage", sha512: "...", size: 123 }]   optional; url is relative to the feed or absolute
//   files[].signature: "<base64>"         optional; Ed25519 signature of the artifact bytes (see update-verify.ts). Without it
//                                         the signature is fetched from <url>.sig. An unsigned artifact is refused.
//   path: "rigwell-1.4.0-x64.AppImage"    optional; used when files is absent
// The feed URL is the updateFeedUrl desktop setting (or RIGWELL_UPDATE_URL). Nothing is checked when it is empty.
import { load as parseYaml } from "js-yaml";

export type UpdateCheck =
  | { status: "no-feed" }
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; releaseDate?: string; notes?: string; downloadUrl?: string; signature?: string; sha512?: string; size?: number }
  | { status: "error"; message: string };

export interface CheckOptions {
  feedUrl: string | undefined;
  currentVersion: string;
  platform?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Compares two semver strings (major.minor.patch with optional -prerelease). Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    if (!m) return undefined;
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) throw new Error(`not a semantic version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i] - pb.n[i];
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length; // a release outranks its prerelease
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The document URL for a feed setting on a platform. */
export function feedDocumentUrl(feedUrl: string, platform: string): string {
  const u = new URL(feedUrl);
  if (/\.(ya?ml|json)$/i.test(u.pathname)) return u.toString();
  const name = platform === "linux" ? "latest-linux.yml" : platform === "darwin" ? "latest-mac.yml" : "latest.yml";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/" + name;
  return u.toString();
}

export async function checkForUpdate(o: CheckOptions): Promise<UpdateCheck> {
  const feed = o.feedUrl?.trim();
  if (!feed) return { status: "no-feed" };
  let docUrl: string;
  try {
    docUrl = feedDocumentUrl(feed, o.platform ?? process.platform);
    if (!/^https?:$/.test(new URL(docUrl).protocol)) return { status: "error", message: "The update feed must be an http(s) URL." };
  } catch { return { status: "error", message: "The update feed URL is not valid." }; }
  try {
    const res = await (o.fetchFn ?? fetch)(docUrl, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), headers: { accept: "application/json, text/yaml, */*" } });
    if (!res.ok) return { status: "error", message: `The update feed answered HTTP ${res.status}.` };
    const text = await res.text();
    const doc = (/\.json$/i.test(new URL(docUrl).pathname) ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown> | undefined;
    const version = doc && typeof doc.version === "string" ? doc.version : undefined;
    if (!version) return { status: "error", message: "The update feed has no version." };
    if (compareVersions(version, o.currentVersion) <= 0) return { status: "up-to-date", version: o.currentVersion };
    const files = Array.isArray(doc!.files) ? (doc!.files as { url?: unknown; signature?: unknown; sha512?: unknown; size?: unknown }[]) : [];
    const rel = typeof files[0]?.url === "string" ? (files[0].url as string) : typeof doc!.path === "string" ? (doc!.path as string) : undefined;
    return {
      status: "available", version,
      releaseDate: typeof doc!.releaseDate === "string" ? doc!.releaseDate : undefined,
      notes: typeof doc!.releaseNotes === "string" ? doc!.releaseNotes : undefined,
      downloadUrl: rel ? new URL(rel, docUrl).toString() : undefined,
      ...(typeof files[0]?.signature === "string" ? { signature: files[0].signature } : {}),
      ...(typeof files[0]?.sha512 === "string" ? { sha512: files[0].sha512 } : {}),
      ...(typeof files[0]?.size === "number" ? { size: files[0].size } : {}),
    };
  } catch (e) {
    return { status: "error", message: `Could not read the update feed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Menu text for a check result. */
export function describeCheck(r: UpdateCheck): string {
  switch (r.status) {
    case "no-feed": return "No update feed is configured. Set the update feed URL in Settings > General.";
    case "up-to-date": return `Rigwell ${r.version} is up to date.`;
    case "available": return `Rigwell ${r.version} is available.${r.notes ? `\n\n${r.notes}` : ""}`;
    case "error": return r.message;
  }
}
