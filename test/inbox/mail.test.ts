import { test, expect } from "bun:test";
import { createServer } from "node:tls";
import { createServer as plainServer } from "node:net";
import { join } from "node:path";
import { generate } from "selfsigned";
import { tmpEnv } from "../storage/helpers.ts";
import { CredentialStore, FileBackend, setCredentialStore } from "../../src/storage/credentials.ts";
import { setSecret } from "../../src/secrets/store.ts";
import { defaultEmail } from "../../src/inbox/store.ts";
import { sendSmtp } from "../../src/inbox/mail.ts";
import { until } from "../workstreams/helpers.ts";

test("SMTP uses a stored password and verified TLS, sends a plain summary, and refuses untrusted certificates or plaintext", async () => {
  const env = tmpEnv(), messages: string[] = [], auth: boolean[] = [], sockets = new Set<any>();
  let hangGreeting = false, connections = 0;
  const cert = await generate([{ name: "commonName", value: "localhost" }], { keySize: 2048, algorithm: "sha256", extensions: [{ name: "basicConstraints", cA: true }, { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }] });
  const server = createServer({ key: cert.private, cert: cert.cert }, (s) => {
    connections++; sockets.add(s); s.on("error", () => {}); s.on("close", () => sockets.delete(s)); s.setEncoding("utf8"); if (!hangGreeting) s.write("220 fixture ESMTP\r\n");
    let buffer = "", data = false, message = "";
    s.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\r\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) { if (line === ".") { messages.push(message); message = ""; data = false; s.write("250 queued\r\n"); } else message += line + "\r\n"; }
        else if (line.startsWith("EHLO")) s.write("250-fixture\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) { auth.push(Buffer.from(line.slice(11), "base64").toString().endsWith("\0fixture-smtp-password")); s.write("235 authenticated\r\n"); }
        else if (line === "DATA") { data = true; s.write("354 send data\r\n"); }
        else if (line === "QUIT") { s.end("221 bye\r\n"); }
        else s.write("250 ok\r\n");
      }
    });
  });
  server.on("tlsClientError", () => {});
  const plain = plainServer((s) => { sockets.add(s); s.on("error", () => {}); s.on("close", () => sockets.delete(s)); s.setEncoding("utf8"); s.write("220 plain ESMTP\r\n"); s.on("data", () => s.write("250 fixture\r\n")); });
  setCredentialStore(new CredentialStore([new FileBackend(() => join(env.root, "credentials.json"))]));
  try {
    setSecret("smtp", "fixture-smtp-password");
    await Promise.all([new Promise<void>((r) => server.listen(0, "127.0.0.1", r)), new Promise<void>((r) => plain.listen(0, "127.0.0.1", r))]);
    const config = { ...defaultEmail(), enabled: true, host: "127.0.0.1", port: (server.address() as any).port, secure: true, user: "fixture", passwordCredential: "smtp", from: "rigwell@example.test", to: "owner@example.test" };
    const message = { subject: "Rigwell test alert", text: "Summary only\nRigwell: #/sessions/fixture", id: "fixture-message" };
    await sendSmtp(config, message, new AbortController().signal, { ca: cert.cert, servername: "localhost" });
    expect(auth).toEqual([true]); expect(messages).toHaveLength(1); expect(messages[0]).toContain("Summary only"); expect(messages[0]).toContain("To: owner@example.test"); expect(messages[0]).not.toContain("fixture-smtp-password");
    const untrusted = await sendSmtp(config, message, new AbortController().signal).then(() => undefined, (e) => e);
    expect(untrusted).toBeDefined(); expect(messages).toHaveLength(1);
    const unencrypted = await sendSmtp({ ...config, secure: false, port: (plain.address() as any).port }, message, new AbortController().signal).then(() => undefined, (e) => e);
    expect(unencrypted).toBeDefined(); expect(auth).toEqual([true]);
    hangGreeting = true; const controller = new AbortController();
    const pending = sendSmtp(config, message, controller.signal, { ca: cert.cert, servername: "localhost" }).then(() => undefined, (e) => e);
    await until(() => connections === 2); controller.abort(); expect(await pending).toBeDefined();
    await until(() => sockets.size === 0); expect(messages).toHaveLength(1);
  } finally { for (const s of sockets) s.destroy(); await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => plain.close(() => r()))]); setCredentialStore(undefined); env.cleanup(); }
}, 15_000);
