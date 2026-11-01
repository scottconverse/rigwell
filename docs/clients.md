# Clients: SDK, WebSocket and TUI

## SDK (`src/sdk/index.ts`)

```ts
import { run, createSession, connectToDaemon } from "./src/sdk/index.ts";

const r = await run("fix the failing test", { cwd, autonomyLevel: "low", onPermission: (req) => ({ selectedOption: "proceed_once" }) });

const s = await createSession({ cwd, modelId: "custom:My-Model-0", onPermission });   // spawns `rigwell exec` (stream-jsonrpc)
for await (const n of s.send("hello")) { /* notifications up to and including agent_turn_completed */ }
await s.send("and then?").done;                                                       // { reason, text, ... }
await s.interrupt(); await s.updateSettings({ autonomyLevel: "medium" }); await s.close();

const d = await connectToDaemon({ url: "ws://127.0.0.1:47822/" });                    // token from daemon.json, or pass `token`
const u = await connectToDaemon({ socketPath: "/path/to/daemon.sock" });              // Unix socket
```

`onPermission`, `onAskUser` and `onPickOptions` answer the harness-to-client requests. Defaults when missing or throwing: cancel.
See `examples/sdk-multi-turn.ts`.

## Daemon WebSocket

`rigwell daemon` also listens on `ws://127.0.0.1:47822/` (`--ws-port <n>`, `--no-ws`, or `daemon.wsPort` in settings).
Each connection is one session; each text frame is one JSON-RPC message (same envelope and `rigwell.` methods as stdio).
A token is required: `?token=<t>` or `Authorization: Bearer <t>`. The token is random per daemon start and is stored with the
socket path and URL in `$RIGWELL_HOME/daemon.json` (mode 0600). Wrong or missing token: HTTP 401. Non-loopback Host: 403.

## TUI

`rigwell` or `rigwell tui [--auto low|medium|high] [-m model] [--use-spec] [--cwd dir]` runs an in-process session.
`--daemon`, `--socket <path>` or `--url ws://... [--token t]` attach to a running daemon instead. Type `/help` for keys and commands.
