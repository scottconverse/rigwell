// Rigwell TypeScript SDK. In-process transport (used by the TUI) lives in ./in-process.ts.
export { run, createSession, connectToDaemon, openSession, readDaemonInfo, RigwellSession } from "./session.ts";
export type {
  Notification, PermissionRequest, PermissionAnswer, AskUserRequest, AskUserAnswer, PickOptionsRequest, PickOptionsAnswer,
  SessionOptions, ExecSessionOptions, DaemonOptions, DaemonInfo, Turn, TurnResult, RunResult,
} from "./session.ts";
export { RpcClient } from "./client.ts";
export { SpawnTransport, SocketTransport, WebSocketTransport } from "./transport.ts";
export type { Transport, SpawnOptions } from "./transport.ts";
