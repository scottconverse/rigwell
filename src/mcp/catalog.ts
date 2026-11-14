// Catalogs are inert until explicitly listed, and entries are installed only from that listing's snapshot.
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import bundled from "./connectors.json";
import { secureUrl } from "../auth/config.ts";
import { lookupCredential, storeCredential } from "../storage/credentials.ts";
import type { AddMcpServerParams } from "./types.ts";

export interface CatalogInput { name: string; label: string; secret?: boolean }
export interface CatalogEntry {
  name: string; description: string; category: string; transport: "http" | "sse" | "stdio";
  auth: "none" | "oauth" | "token"; docs: string;
  url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>; inputs?: CatalogInput[];
}
export interface CatalogRow extends CatalogEntry { key: string; source: string }
const LIMIT = 512 * 1024;
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const nameOk = (v: any) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const text = (v: any) => typeof v === "string" && v.length > 0 && v.length <= 4000;
function urlOk(v: any) { if (!secureUrl(v)) return false; const u = new URL(v); return !u.username && !u.password && !u.hash; }
function stringMap(v: any): boolean { return v === undefined || (object(v) && Object.keys(v).length <= 40 && Object.values(v).every((x) => typeof x === "string" && x.length <= 4000)); }
function entry(v: any): CatalogEntry {
  if (!object(v) || !nameOk(v.name) || !text(v.description) || !text(v.category) || !urlOk(v.docs)
    || !["http", "sse", "stdio"].includes(v.transport) || !["none", "oauth", "token"].includes(v.auth)
    || !stringMap(v.env) || !stringMap(v.headers)) throw new Error("Invalid connector entry");
  if (v.transport === "stdio" ? !text(v.command) || v.auth === "oauth" : !text(v.url)) throw new Error("Invalid connector target");
  if (v.args !== undefined && (!Array.isArray(v.args) || v.args.length > 80 || !v.args.every((x: any) => typeof x === "string" && x.length <= 4000))) throw new Error("Invalid connector arguments");
  const inputs: CatalogInput[] = v.inputs ?? [];
  if (!Array.isArray(inputs) || inputs.length > 20 || inputs.some((i) => !object(i) || !nameOk(i.name) || !text(i.label) || (i.secret !== undefined && typeof i.secret !== "boolean")) || new Set(inputs.map((i) => i.name)).size !== inputs.length) throw new Error("Invalid connector inputs");
  const known = new Set(inputs.map((i) => i.name));
  const fields = [v.url, v.command, ...(v.args ?? []), ...Object.values(v.headers ?? {}), ...Object.values(v.env ?? {})];
  for (const field of fields) for (const match of String(field ?? "").matchAll(/\{\{([^{}]+)\}\}/g)) if (!known.has(match[1]!)) throw new Error("Undeclared connector input");
  for (const i of inputs.filter((i) => i.secret)) if ([v.url, v.command, ...(v.args ?? [])].some((s) => String(s ?? "").includes(`{{${i.name}}}`))) throw new Error("Secret inputs belong only in headers or environment values");
  return { name: v.name, description: v.description, category: v.category, transport: v.transport, auth: v.auth, docs: v.docs,
    ...(v.transport === "stdio" ? { command: v.command, args: v.args ?? [], env: v.env ?? {} } : { url: v.url, headers: v.headers ?? {} }), inputs };
}
async function load(source: string): Promise<unknown> {
  if (isAbsolute(source) || source.startsWith("file:")) {
    const file = source.startsWith("file:") ? fileURLToPath(source) : source;
    if ((await stat(file)).size > LIMIT) throw new Error("Catalog exceeds 512 KiB");
    const bytes = await readFile(file);
    if (bytes.length > LIMIT) throw new Error("Catalog exceeds 512 KiB");
    return JSON.parse(bytes.toString("utf8"));
  }
  if (!urlOk(source)) throw new Error("Catalog sources require HTTPS, loopback HTTP or an absolute JSON file path");
  const res = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Catalog returned HTTP ${res.status}`); }
  const reader = res.body?.getReader(); if (!reader) throw new Error("Empty catalog response");
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > LIMIT) throw new Error("Catalog exceeds 512 KiB"); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export class ConnectorCatalog {
  private rows = new Map<string, CatalogRow>();
  async list(sources: unknown = []) {
    if (!Array.isArray(sources) || sources.length > 16 || sources.some((s) => typeof s !== "string" || s.length > 4000)) throw new Error("Provide at most 16 catalog source URLs or file paths");
    const rows = new Map<string, CatalogRow>(), warnings: string[] = [];
    const allSources = ["bundled", ...new Set(sources as string[])];
    const loaded = await Promise.allSettled(allSources.map((s) => s === "bundled" ? Promise.resolve(bundled) : load(s)));
    for (const [index, source] of allSources.entries()) {
      try {
        const result = loaded[index]!; if (result.status === "rejected") throw result.reason;
        const data: any = result.value;
        const entries = Array.isArray(data) ? data : data?.connectors;
        if (!Array.isArray(entries) || entries.length > 256) throw new Error("Catalog must contain a connectors array of at most 256 entries");
        const parsed = entries.map(entry);
        for (const e of parsed) { const key = createHash("sha256").update(source + JSON.stringify(e)).digest("hex"); rows.set(key, { ...e, key, source }); }
      } catch (e) { warnings.push(`${source}: ${(e as Error).message}`); }
    }
    this.rows = rows; return { entries: [...rows.values()], warnings };
  }
  prepare(key: string, values: Record<string, string> = {}, name?: string, taken: (name: string) => boolean = () => false): AddMcpServerParams {
    const row = this.rows.get(key); if (!row) throw new Error("Open the catalog again before adding this connector");
    if (!object(values) || Object.values(values).some((v) => typeof v !== "string" || v.length > 4000)) throw new Error("Invalid connector input values");
    if (!nameOk(name ?? row.name)) throw new Error("Invalid connector name");
    if (taken(name ?? row.name)) throw new Error("A server with this name already exists; choose another name");
    for (const input of row.inputs ?? []) if (!values[input.name]?.trim()) throw new Error(`Enter ${input.label}`);
    const expand = (s: string, encode = false) => s.replace(/\{\{([^{}]+)\}\}/g, (_, k) => encode ? encodeURIComponent(values[k]!) : values[k]!);
    const map = (m: Record<string, string> = {}) => Object.fromEntries(Object.entries(m).map(([k, v]) => {
      const expanded = expand(v);
      if (!(row.inputs ?? []).some((i) => i.secret && v.includes(`{{${i.name}}}`))) return [k, expanded];
      const credential = `mcp-catalog:${randomUUID()}`; storeCredential(credential, expanded); return [k, `keychain:${credential}`];
    }));
    const url = row.url && expand(row.url, true);
    if (row.transport !== "stdio" && !urlOk(url)) throw new Error("Connector target requires HTTPS or loopback HTTP without credentials");
    return { name: name ?? row.name, type: row.transport, ...(row.transport === "stdio" ? { command: expand(row.command!), args: row.args?.map((s) => expand(s)), env: map(row.env) } : { url, headers: map(row.headers), oauth: row.auth === "oauth" ? {} : false }) };
  }
}
/** Resolve only explicit store references at the last transport boundary, never in protocol/config output. */
export function mcpSecret(value: string): string {
  if (!value.startsWith("keychain:")) return value;
  const secret = lookupCredential(value.slice(9)); if (secret === undefined) throw new Error("MCP credential is missing; add it to the credential store"); return secret;
}
