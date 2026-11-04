// Domain-filtering HTTP proxy for sandboxed commands (spec 5.5.8 network allow-list).
// Handles CONNECT (https) and absolute-URI http requests. Enforcement is complete only because the
// sandbox has no other network path (bubblewrap --unshare-net / seatbelt deny network*).
import * as net from "node:net";
import { domainAllowed } from "./policy.ts";

export interface NetworkViolation {
  host: string;
  reason: "deny-list" | "not-allowed";
}

export interface ProxyHandle {
  /** Unix socket path or TCP port, depending on how it listens. */
  address: string | number;
  close(): Promise<void>;
}

export interface ProxyOptions {
  allowed: string[];
  denied: string[];
  onViolation: (v: NetworkViolation) => void;
  listen: { unix: string } | { port: number };
  /** Test hook: where to connect for an allowed host. */
  connect?: (host: string, port: number) => net.Socket;
}

function parseHostPort(s: string, dflt: number): { host: string; port: number } {
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return { host: s, port: dflt };
  return { host: m[1]!, port: m[2] ? Number(m[2]) : dflt };
}

export function startProxy(o: ProxyOptions): Promise<ProxyHandle> {
  const connect = o.connect ?? ((h, p) => net.connect(p, h));
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > 65536) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      const first = head.split("\r\n")[0] ?? "";
      const [method = "", target = ""] = first.split(" ");
      let host = "";
      let port = 80;
      if (method.toUpperCase() === "CONNECT") {
        ({ host, port } = parseHostPort(target, 443));
      } else {
        try {
          const u = new URL(target);
          host = u.hostname.replace(/^\[|\]$/g, "");
          port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
        } catch {
          client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }
      }
      const verdict = domainAllowed(host, o.allowed, o.denied);
      if (!verdict.ok) {
        o.onViolation({ host, reason: verdict.reason });
        client.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nBlocked by the Rigwell sandbox: ${host} (${verdict.reason}).\n`);
        return;
      }
      const upstream = connect(host, port);
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      upstream.on("connect", () => {
        if (method.toUpperCase() === "CONNECT") {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length) upstream.write(rest);
        } else {
          upstream.write(Buffer.concat([Buffer.from(head + "\r\n\r\n", "latin1"), rest]));
        }
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      const a = server.address();
      resolve({
        address: typeof a === "string" ? a : (a as net.AddressInfo).port,
        close: () => new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    };
    if ("unix" in o.listen) server.listen(o.listen.unix, done);
    else server.listen(o.listen.port, "127.0.0.1", done);
  });
}
