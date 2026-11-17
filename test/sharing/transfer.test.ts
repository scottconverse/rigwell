import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpEnv } from "../storage/helpers.ts";
import { appendMessage, createSession } from "../../src/storage/transcript.ts";
import { renderSharedSession, readImportedSession, SHARE_MAX_BYTES, type SharedSession } from "../../src/sharing/session.ts";
import { importSharedSource, readSharedSource, shareSecretGist } from "../../src/sharing/transfer.ts";

const value: SharedSession = { schemaVersion: 1, title: "Fixture", exportedAt: "2026-11-14T00:00:00.000Z", messages: [{ role: "user", text: "Shared task" }] };
async function failure(run: () => Promise<unknown>) { try { await run(); return "no failure"; } catch (e) { return String(e); } }

test("file and URL imports retain inert data; redirects and unsupported schemes are refused", async () => {
  const env = tmpEnv(), content = renderSharedSession(value, "html");
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req): Response {
    if (new URL(req.url).pathname === "/redirect") return Response.redirect(`http://127.0.0.1:${web.port}/file`, 302);
    return new Response(content);
  } });
  try {
    const file = join(env.root, "shared.html"); writeFileSync(file, content);
    const imported = await importSharedSource(file); expect(readImportedSession(imported.importId)).toEqual(value);
    expect(await readSharedSource(`http://127.0.0.1:${web.port}/file`)).toEqual(value);
    expect(await failure(() => readSharedSource(`http://127.0.0.1:${web.port}/redirect`))).not.toBe("no failure");
    expect(await failure(() => readSharedSource("file:///private/file"))).toContain("scheme");
    expect(await failure(() => readSharedSource("https://owner:password@example.invalid/file"))).toContain("credentials");
  } finally { web.stop(true); env.cleanup(); }
});

test("gist sharing waits for actual user approval, sends redacted content as unlisted and imports its share link without authentication", async () => {
  const env = tmpEnv(), files = createSession({ id: crypto.randomUUID(), cwd: env.root, title: "Share fixture" });
  await appendMessage(files, { id: "message", role: "user", content: [{ type: "text", text: "Opaque secret: fixture-private-value" }] }, null);
  const calls: { method: string; authorization: string | null; body?: any }[] = [];
  let content = "", tokenReads = 0, approve!: (answer: any) => void;
  const web = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const call = { method: req.method, authorization: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : undefined }; calls.push(call);
    if (req.method === "POST") { content = call.body.files["rigwell-session.md"].content; return Response.json({ html_url: "https://gist.github.com/fixture/abcde123" }, { status: 201 }); }
    return Response.json({ files: { "rigwell-session.md": { content, truncated: false } } });
  } });
  const deps = { apiRoot: `http://127.0.0.1:${web.port}`, secrets: ["fixture-private-value"], token: async () => { tokenReads++; return "fixture-token"; } };
  try {
    expect(await shareSecretGist(files.id, async () => ({ selectedOption: "cancel" }), deps)).toEqual({ shared: false });
    expect(await failure(() => shareSecretGist(files.id, undefined, deps))).toContain("confirmation"); expect(calls).toHaveLength(0); expect(tokenReads).toBe(0);
    const sharing = shareSecretGist(files.id, () => new Promise((r) => { approve = r; }), deps);
    await Bun.sleep(0); expect(calls).toHaveLength(0); expect(tokenReads).toBe(0);
    approve({ selectedOption: "proceed_once" }); const result = await sharing;
    expect(result).toEqual({ shared: true, url: "https://gist.github.com/fixture/abcde123" });
    expect(calls[0]!.body.public).toBe(false); expect(calls[0]!.authorization).toBe("Bearer fixture-token"); expect(content).not.toContain("fixture-private-value");
    const imported = await readSharedSource(result.url!, deps); expect(imported.messages[0]!.text).toContain("[redacted]");
    expect(calls[1]!.authorization).toBeNull(); expect(tokenReads).toBe(1);
  } finally { web.stop(true); env.cleanup(); }
});

test("streamed oversized imports cancel their body and cannot follow an untrusted gist raw URL", async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(SHARE_MAX_BYTES + 1)); }, cancel() { cancelled = true; } }));
  expect(await failure(() => readSharedSource("https://fixture.invalid/session", { fetch: (async () => oversized) as any }))).toContain("10 MiB"); expect(cancelled).toBe(true);
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json({ files: { "rigwell-session.md": { truncated: true, raw_url: "http://127.0.0.1/private" } } }); };
  expect(await failure(() => readSharedSource("https://gist.github.com/fixture/abcde123", { fetch: fetcher as any }))).toContain("raw-file URL"); expect(requests).toBe(1);
});
