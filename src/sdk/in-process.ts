// A transport that talks to a Connection in this process (used by the TUI, like `exec "prompt"`).
import { createConnection, type ConnectionOptions } from "../daemon/connection.ts";
import { METHOD_PREFIX } from "../protocol/rpc.ts";
import { createSidePane, type ConnCtx } from "../sidepane/index.ts";
import type { Transport } from "./transport.ts";

/**
 * `sidePane: false` leaves the side-chat methods out. By default the connection answers daemon.side_chat_* (so the TUI's
 * /btw works in process); terminals, files and the browser tool are not wired here.
 */
export function inProcessTransport(opts: Partial<ConnectionOptions> & { sidePane?: boolean } = {}): Transport {
  const { sidePane, ...connOpts } = opts;
  const sp = sidePane === false ? undefined : createSidePane({ log: connOpts.log });
  const t: Transport = {
    onMessage: () => {}, onClose: () => {},
    write(message) { conn.peer.feed(message + "\n"); },
    async close() { await conn.shutdown(); if (sp) { sp.connectionClosed(ctx); await sp.closeAll(); } t.onClose(); },
  };
  const ctx: ConnCtx = {
    id: crypto.randomUUID(),
    session: () => conn.session,
    notify: (n) => conn.peer.notify(METHOD_PREFIX + "session_notification", { ...(conn.session ? { sessionId: conn.session.id } : {}), notification: n }),
  };
  const side = sp ? Object.fromEntries(Object.entries(sp.methodsFor(ctx)).filter(([k]) => k.startsWith("daemon.side_chat_"))) : {};
  const conn = createConnection((line) => queueMicrotask(() => t.onMessage(line.replace(/\n+$/, ""))), {
    canPrompt: true, ...connOpts, extraMethods: { ...side, ...connOpts.extraMethods },
  });
  return t;
}
