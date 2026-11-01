// NDJSON JSON-RPC peer (spec §3.1.1-3.1.3). One instance per connection.

export const PROTOCOL_VERSION = "0.1.0";
export const METHOD_PREFIX = "rigwell.";

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTHENTICATION_ERROR: -32001,
  ENTITY_NOT_FOUND: -32004,
  SESSION_DISCONNECTED: -32005,
  CONFLICT: -32006,
  REQUEST_CANCELLED: -32800,
} as const;

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export interface Envelope {
  jsonrpc: "2.0";
  type: "request" | "response" | "notification";
  protocolVersion?: string;
  id?: string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Writes one line per message; escapes U+2028/U+2029; a single queue keeps lines whole. */
export function encodeLine(msg: unknown): string {
  return JSON.stringify(msg).replace(/ /g, "\\u2028").replace(/ /g, "\\u2029") + "\n";
}

export class RpcPeer {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private inFlight = new Set<string>();
  private buf = "";
  private closed = false;
  onClose?: () => void;

  constructor(
    private write: (line: string) => void,
    private handler: RequestHandler,
    private log: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  /** Feed raw bytes/text from the transport. */
  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcError(ErrorCodes.SESSION_DISCONNECTED, "connection closed"));
    this.pending.clear();
    this.onClose?.();
  }

  private send(msg: Envelope): void {
    if (this.closed) return;
    this.write(encodeLine({ ...msg, protocolVersion: PROTOCOL_VERSION }));
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", type: "notification", method, params });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new RpcError(ErrorCodes.SESSION_DISCONNECTED, "connection closed"));
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", type: "request", id, method, params });
    });
  }

  private respondError(id: string | null, code: number, message: string, data?: unknown) {
    this.send({ jsonrpc: "2.0", type: "response", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  private handleLine(line: string): void {
    const t = line.trimStart();
    if (!t) return;
    if (t[0] !== "{" && t[0] !== "[") {
      this.log(`[rpc] non-JSON line skipped: ${t.slice(0, 120)}`);
      return;
    }
    let msg: Envelope;
    try {
      msg = JSON.parse(t);
    } catch {
      this.respondError(null, ErrorCodes.PARSE_ERROR, "Parse error");
      return;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      this.respondError((msg as any)?.id ?? null, ErrorCodes.INVALID_REQUEST, "Invalid request format");
      return;
    }
    const type = msg.type ?? (msg.method ? (msg.id != null ? "request" : "notification") : "response");
    if (type === "response") {
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (type === "notification") return; // the harness takes no client notifications in Phase 1
    if (typeof msg.id !== "string" || typeof msg.method !== "string") {
      this.respondError(typeof msg.id === "string" ? msg.id : null, ErrorCodes.INVALID_REQUEST, "Invalid request format");
      return;
    }
    const id = msg.id;
    if (this.inFlight.has(id)) {
      this.respondError(id, ErrorCodes.CONFLICT, `request id ${id} is already in flight`);
      return;
    }
    if (!msg.method.startsWith(METHOD_PREFIX)) {
      this.respondError(id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      return;
    }
    this.inFlight.add(id);
    const method = msg.method.slice(METHOD_PREFIX.length);
    this.handler(method, (msg.params ?? {}) as Record<string, unknown>)
      .then((result) => this.send({ jsonrpc: "2.0", type: "response", id, result: result ?? {} }))
      .catch((e) => {
        if (e instanceof RpcError) this.respondError(id, e.code, e.message, e.data);
        else this.respondError(id, ErrorCodes.INTERNAL_ERROR, String(e?.message ?? e));
      })
      .finally(() => this.inFlight.delete(id));
  }
}
