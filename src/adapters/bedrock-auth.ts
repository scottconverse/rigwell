// AWS pieces for the Bedrock adapters, on node:crypto only (no AWS SDK): SigV4 signing, credential lookup
// (bearer token, access keys, shared-credentials profile, credential-export command) and the event-stream decoder.
// Why no SDK: ConverseStream is one signed POST plus a framed response, about 250 lines here against a dependency
// tree of hundreds of modules, and the harness does its own retrying (spec 4.6.9).
import { createHash, createHmac } from "node:crypto";
import { spawnShell } from "../platform/shell.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelError, type ModelConfig } from "../core/types.ts";

// ---------- SigV4 ----------

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: number }

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of one path segment, as SigV4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Returns the headers to send: the given ones plus host, x-amz-date, x-amz-security-token (when a session token is
 * set) and Authorization. For services other than S3 the canonical path encodes the (already encoded) path once more.
 */
export function signV4(opts: {
  method: string; url: string; headers: Record<string, string>; body: string | Uint8Array;
  region: string; service: string; credentials: AwsCredentials; now?: Date;
}): Record<string, string> {
  const u = new URL(opts.url);
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  headers.host = u.host;
  headers["x-amz-date"] = amzDate;
  if (opts.credentials.sessionToken) headers["x-amz-security-token"] = opts.credentials.sessionToken;
  const names = Object.keys(headers).filter((n) => n !== "authorization").sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const path = u.pathname === "" ? "/" : u.pathname.split("/").map((seg) => enc(seg)).join("/");
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [opts.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(opts.body)].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.credentials.secretAccessKey}`, date), opts.region), opts.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host; // fetch sets Host itself
  return headers;
}

// ---------- credentials ----------

const authErr = (msg: string) => new ModelError("auth", msg);

function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[(?:profile\s+)?([^\]]+)\]$/.exec(line);
    if (sec) { cur = out[sec[1]!.trim()] = out[sec[1]!.trim()] ?? {}; continue; }
    const eq = line.indexOf("=");
    if (cur && eq > 0) cur[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function runShell(cmd: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawnShell(cmd, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** JSON (AccessKeyId/SecretAccessKey/SessionToken/Expiration, also camelCase) or `export AWS_*=` lines. */
export function parseCredentialOutput(text: string): AwsCredentials | undefined {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const c = j.Credentials ?? j.credentials ?? j;
    const id = c.AccessKeyId ?? c.accessKeyId, secret = c.SecretAccessKey ?? c.secretAccessKey;
    if (id && secret) {
      const exp = c.Expiration ?? c.expiration;
      const ms = exp ? Date.parse(exp) : NaN;
      return { accessKeyId: id, secretAccessKey: secret, sessionToken: c.SessionToken ?? c.sessionToken, ...(Number.isFinite(ms) ? { expiresAt: ms } : {}) };
    }
  } catch { /* not JSON */ }
  const env: Record<string, string> = {};
  for (const m of t.matchAll(/^\s*(?:export\s+)?(AWS_[A-Z_]+)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/gm)) env[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
  }
  return undefined;
}

const exportCache = new Map<string, AwsCredentials>();
const EXPORT_TTL_MS = 5 * 60_000;

/** Test hook. */
export function clearAwsCredentialCache(): void { exportCache.clear(); }

async function fromCommand(cfg: NonNullable<ModelConfig["bedrock"]>, env: NodeJS.ProcessEnv): Promise<AwsCredentials> {
  const cmd = cfg.awsCredentialExport;
  if (!cmd) throw authErr("Bedrock auth method credentials-command needs bedrock.awsCredentialExport");
  const cached = exportCache.get(cmd);
  if (cached && (cached.expiresAt ?? 0) - 60_000 > Date.now()) return cached;
  let r = await runShell(cmd, env);
  let creds = r.code === 0 ? parseCredentialOutput(r.out) : undefined;
  if (!creds && cfg.awsAuthRefresh) {
    await runShell(cfg.awsAuthRefresh, env, 300_000);
    r = await runShell(cmd, env);
    creds = r.code === 0 ? parseCredentialOutput(r.out) : undefined;
  }
  if (!creds) throw authErr(`The AWS credential export command ${r.code === 0 ? "printed no credentials" : `failed (exit ${r.code}): ${r.err.trim().slice(0, 200)}`}`);
  creds.expiresAt ??= Date.now() + EXPORT_TTL_MS;
  exportCache.set(cmd, creds);
  return creds;
}

export type BedrockAuth = { kind: "bearer"; token: string } | { kind: "sigv4"; credentials: AwsCredentials };

export async function resolveBedrockAuth(m: ModelConfig, env: NodeJS.ProcessEnv = process.env): Promise<BedrockAuth> {
  const cfg = m.bedrock;
  if (!cfg) throw authErr("Model has no bedrock settings");
  const bearer = cfg.awsBearerToken ?? m.apiKey ?? env.AWS_BEARER_TOKEN_BEDROCK;
  const keys = cfg.awsAccessKeyId && cfg.awsSecretAccessKey ? { accessKeyId: cfg.awsAccessKeyId, secretAccessKey: cfg.awsSecretAccessKey, sessionToken: cfg.awsSessionToken } : undefined;
  const method = cfg.awsAuthMethod
    ?? (cfg.awsBearerToken || m.apiKey ? "bearer-token" : keys ? "access-keys" : cfg.awsCredentialExport ? "credentials-command" : cfg.awsProfile ? "profile"
      : env.AWS_BEARER_TOKEN_BEDROCK ? "bearer-token" : "access-keys");
  switch (method) {
    case "bearer-token":
      if (!bearer) throw authErr("Bedrock bearer-token auth needs a token (apiKey, bedrock.awsBearerToken or AWS_BEARER_TOKEN_BEDROCK)");
      return { kind: "bearer", token: bearer };
    case "access-keys": {
      const k = keys ?? (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN } : undefined);
      if (!k) throw authErr("Bedrock access-keys auth needs awsAccessKeyId and awsSecretAccessKey (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)");
      return { kind: "sigv4", credentials: k };
    }
    case "profile": {
      const name = cfg.awsProfile ?? env.AWS_PROFILE ?? "default";
      const file = env.AWS_SHARED_CREDENTIALS_FILE ?? join(env.HOME ?? homedir(), ".aws", "credentials");
      const sec = existsSync(file) ? parseIni(readFileSync(file, "utf8"))[name] : undefined;
      if (!sec?.aws_access_key_id || !sec.aws_secret_access_key) {
        throw authErr(`AWS profile ${JSON.stringify(name)} has no static keys in ${file}. For SSO or assumed roles use the credentials-command method with awsCredentialExport.`);
      }
      return { kind: "sigv4", credentials: { accessKeyId: sec.aws_access_key_id, secretAccessKey: sec.aws_secret_access_key, sessionToken: sec.aws_session_token } };
    }
    case "credentials-command":
      return { kind: "sigv4", credentials: await fromCommand(cfg, env) };
    default:
      throw authErr(`Unknown Bedrock auth method ${JSON.stringify(method)}`);
  }
}

/** Headers for one Bedrock request: Bearer, or the SigV4-signed set. */
export async function bedrockHeaders(
  m: ModelConfig, service: string, method: string, url: string, headers: Record<string, string>, body: string,
): Promise<Record<string, string>> {
  const base = { ...headers };
  delete base.authorization; // the OpenAI path puts the plain key here; Bedrock auth replaces it
  const auth = await resolveBedrockAuth(m);
  if (auth.kind === "bearer") return { ...base, authorization: `Bearer ${auth.token}` };
  return signV4({ method, url, headers: base, body, region: m.bedrock!.awsRegion, service, credentials: auth.credentials });
}

// ---------- event stream ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface EventStreamMessage { headers: Record<string, string | number | boolean>; payload: Uint8Array }

/** Decodes one message from the start of `buf`, or returns undefined when it is not complete yet. */
export function decodeEventMessage(buf: Uint8Array): { message: EventStreamMessage; length: number } | undefined {
  if (buf.length < 12) return undefined;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const total = dv.getUint32(0), hLen = dv.getUint32(4);
  if (total < 16 || hLen > total - 16) throw new ModelError("unavailable", "Corrupt event stream frame", { retryable: true });
  if (buf.length < total) return undefined;
  if (crc32(buf, 0, 8) !== dv.getUint32(8) || crc32(buf, 0, total - 4) !== dv.getUint32(total - 4)) {
    throw new ModelError("unavailable", "Event stream checksum mismatch", { retryable: true });
  }
  const headers: Record<string, string | number | boolean> = {};
  let o = 12;
  const end = 12 + hLen;
  const td = new TextDecoder();
  while (o < end) {
    const nl = buf[o++]!;
    const name = td.decode(buf.subarray(o, o + nl)); o += nl;
    const type = buf[o++]!;
    switch (type) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: headers[name] = dv.getInt8(o); o += 1; break;
      case 3: headers[name] = dv.getInt16(o); o += 2; break;
      case 4: headers[name] = dv.getInt32(o); o += 4; break;
      case 5: case 8: headers[name] = Number(dv.getBigInt64(o)); o += 8; break;
      case 6: case 7: { const l = dv.getUint16(o); o += 2; headers[name] = td.decode(buf.subarray(o, o + l)); o += l; break; }
      case 9: o += 16; break;
      default: throw new ModelError("unavailable", `Unknown event stream header type ${type}`, { retryable: true });
    }
  }
  return { message: { headers, payload: buf.subarray(end, total - 4) }, length: total };
}

export async function* parseEventStream(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<EventStreamMessage> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf); next.set(value, buf.length);
      buf = next;
      for (let d = decodeEventMessage(buf); d; d = decodeEventMessage(buf)) {
        buf = buf.subarray(d.length);
        yield d.message;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Encoder (the fake server and tests use it). */
export function encodeEventMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const te = new TextEncoder();
  const hs: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = te.encode(k), vb = te.encode(v);
    hs.push(kb.length, ...kb, 7, (vb.length >> 8) & 0xff, vb.length & 0xff, ...vb);
  }
  const pb = typeof payload === "string" ? te.encode(payload) : payload;
  const total = 12 + hs.length + pb.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total); dv.setUint32(4, hs.length);
  dv.setUint32(8, crc32(out, 0, 8));
  out.set(hs, 12); out.set(pb, 12 + hs.length);
  dv.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}
