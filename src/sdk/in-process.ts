// A transport that talks to a Connection in this process (used by the TUI, like `exec "prompt"`).
import { createConnection, type ConnectionOptions } from "../daemon/connection.ts";
import type { Transport } from "./transport.ts";

export function inProcessTransport(opts: Partial<ConnectionOptions> = {}): Transport {
  const t: Transport = {
    onMessage: () => {}, onClose: () => {},
    write(message) { conn.peer.feed(message + "\n"); },
    async close() { await conn.shutdown(); t.onClose(); },
  };
  const conn = createConnection((line) => queueMicrotask(() => t.onMessage(line.replace(/\n+$/, ""))), { canPrompt: true, ...opts });
  return t;
}
