#!/usr/bin/env bun
// rigwell CLI: `exec` (stdio JSON-RPC or a one-shot prompt) and `daemon` (many sessions over a Unix socket).
import { join, resolve } from "node:path";
import { rigwellHome } from "../storage/paths.ts";
import { createConnection, type ConnectionOptions } from "../daemon/connection.ts";
import { startDaemon, defaultSocketPath } from "../daemon/daemon.ts";
import type { AutonomyLevel } from "../core/types.ts";

const log = (m: string) => process.stderr.write(m + "\n");

const USAGE = `Usage:
  rigwell exec --input-format stream-jsonrpc --output-format stream-jsonrpc [options]
  rigwell exec [options] "<prompt>"
  rigwell daemon [--socket <path>] [--ws-port <n>] [--no-ws]
  rigwell [tui] [options]        interactive terminal UI (default when no subcommand is given)
  rigwell eval <run|report|tasks> [options]   (see rigwell eval --help)

Options for exec:
  --auto <low|medium|high>     autonomy level (default: off, read-only)
  --skip-permissions-unsafe    run every tool call without asking (not with --auto)
  -m, --model <id>             model id, e.g. custom:My-Model-0
  --cwd <dir>                  working directory (default: current directory)
  -s, --session-id <id>        continue an existing session (prompt mode)
  --settings <path>            extra settings file for this process (runtime level)

Options for tui (also --auto, -m/--model, --cwd, --skip-permissions-unsafe, --settings):
  --use-spec                   start in spec mode
  --daemon                     use the running daemon's Unix socket instead of an in-process session
  --socket <path>              daemon socket path (implies --daemon)
  --url <ws://...> --token <t> connect to the daemon over WebSocket (token defaults to daemon.json)`;

interface ExecArgs {
  inputFormat?: string; outputFormat?: string; auto?: AutonomyLevel; skip: boolean;
  model?: string; cwd: string; sessionId?: string; settings?: string; prompt?: string;
}

function fail(msg: string): never { log(`rigwell: ${msg}`); process.exit(2); }

function parseExec(argv: string[]): ExecArgs {
  const a: ExecArgs = { skip: false, cwd: process.cwd() };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => argv[++i] ?? fail(`${k} needs a value`);
    switch (k) {
      case "--input-format": a.inputFormat = val(); break;
      case "--output-format": a.outputFormat = val(); break;
      case "--auto": {
        const v = val();
        if (!["low", "medium", "high"].includes(v)) fail(`--auto must be low, medium or high`);
        a.auto = v as AutonomyLevel; break;
      }
      case "--skip-permissions-unsafe": a.skip = true; break;
      case "-m": case "--model": a.model = val(); break;
      case "--cwd": a.cwd = resolve(val()); break;
      case "-s": case "--session-id": a.sessionId = val(); break;
      case "--settings": a.settings = resolve(val()); break;
      case "-h": case "--help": log(USAGE); process.exit(0);
      default:
        if (k.startsWith("-")) fail(`unknown option ${k}\n${USAGE}`);
        rest.push(k);
    }
  }
  if (a.auto && a.skip) fail("--auto and --skip-permissions-unsafe cannot be used together");
  if (rest.length) a.prompt = rest.join(" ");
  return a;
}

async function readStdin(onChunk: (s: string) => void) {
  const dec = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) onChunk(dec.decode(chunk as Uint8Array, { stream: true }));
}

async function execJsonRpc(a: ExecArgs) {
  if (a.inputFormat !== "stream-jsonrpc" || a.outputFormat !== "stream-jsonrpc") {
    fail("use both --input-format stream-jsonrpc and --output-format stream-jsonrpc, or pass a prompt");
  }
  const conn = createConnection((line) => process.stdout.write(line), {
    canPrompt: true, runtimeSettingsPath: a.settings, log,
    forced: { autonomyLevel: a.auto, skipPermissions: a.skip || undefined, modelId: a.model },
  });
  await readStdin((s) => conn.peer.feed(s));
  await conn.shutdown();
  process.exit(0);
}

/** One-shot prompt: drives a connection in-process and prints the assistant's text. Never prompts (spec §5.5.6). */
async function execPrompt(a: ExecArgs) {
  let reqN = 0;
  const waiters = new Map<string, (m: any) => void>();
  let turnDone: (reason: string) => void;
  const finished = new Promise<string>((r) => (turnDone = r));
  let lastMessageId = "";
  let lastReason = "";
  const opts: ConnectionOptions = {
    canPrompt: false, runtimeSettingsPath: a.settings, log,
    forced: { autonomyLevel: a.auto ?? "off", skipPermissions: a.skip || undefined, modelId: a.model },
  };
  const conn = createConnection((line) => {
    const m = JSON.parse(line);
    if (m.type === "response") return waiters.get(m.id)?.(m);
    const n = m.params?.notification;
    if (!n) return;
    if (n.type === "assistant_text_delta") {
      if (lastMessageId && n.messageId !== lastMessageId) process.stdout.write("\n");
      lastMessageId = n.messageId;
      process.stdout.write(n.textDelta);
    } else if (n.type === "tool_call" && n.toolUse?.input && Object.keys(n.toolUse.input).length) {
      // shown once per call when complete input arrives in the final message
    } else if (n.type === "tool_result") {
      log(`[tool] ${n.isError ? "error" : "ok"} ${n.toolUseId}`);
    } else if (n.type === "error") {
      log(`rigwell: ${n.message}`);
    } else if (n.type === "agent_turn_completed") {
      lastReason = n.reason;
      turnDone(n.reason);
    }
  }, opts);
  const call = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((res) => {
      const id = `cli-${++reqN}`;
      waiters.set(id, res);
      conn.peer.feed(JSON.stringify({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params }) + "\n");
    });
  const init = a.sessionId
    ? await call("load_session", { sessionId: a.sessionId, cwd: a.cwd })
    : await call("initialize_session", { machineId: "default", cwd: a.cwd });
  if (init.error) fail(init.error.message);
  log(`[session] ${init.result.sessionId} model=${init.result.settings.modelId} autonomy=${init.result.settings.autonomyLevel}`);
  const added = await call("add_user_message", { text: a.prompt });
  if (added.error) fail(added.error.message);
  let reason = await finished;
  // Background jobs may still be running; wait for them and for the wake turns they cause.
  await conn.session?.settled();
  reason = lastReason || reason;
  process.stdout.write("\n");
  await call("close_session", { reason: "other" });
  log(`[turn] ${reason}`);
  process.exit(reason === "completed" ? 0 : 1);
}

/** `rigwell` / `rigwell tui`: the interactive UI, on an in-process session or a daemon connection. */
async function tui(argv: string[]) {
  const TUI_ONLY_VALUE = ["--socket", "--url", "--token"];
  const TUI_ONLY_FLAG = ["--use-spec", "--daemon"];
  const execArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (TUI_ONLY_VALUE.includes(argv[i])) i++;
    else if (!TUI_ONLY_FLAG.includes(argv[i])) execArgv.push(argv[i]);
  }
  const a = parseExec(execArgv);
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? fail(`${k} needs a value`) : undefined; };
  const { runTui } = await import("../tui/app.ts");
  const { SocketTransport, WebSocketTransport } = await import("../sdk/transport.ts");
  const { readDaemonInfo } = await import("../sdk/session.ts");
  const url = val("--url");
  const socket = val("--socket");
  const makeTransport = async () => {
    if (url) return WebSocketTransport.connect(url, val("--token") ?? readDaemonInfo()?.token);
    if (socket || argv.includes("--daemon")) return SocketTransport.connect(socket ? resolve(socket) : defaultSocketPath());
    const { inProcessTransport } = await import("../sdk/in-process.ts");
    return inProcessTransport({ canPrompt: true, runtimeSettingsPath: a.settings, log });
  };
  const sessionParams: Record<string, unknown> = {};
  if (a.model) sessionParams.modelId = a.model;
  if (a.auto) sessionParams.autonomyLevel = a.auto;
  if (a.skip) sessionParams.skipPermissionsUnsafe = true;
  if (argv.includes("--use-spec")) sessionParams.interactionMode = "spec";
  const code = await runTui({ cwd: a.cwd, makeTransport, sessionParams, homeDir: rigwellHome(), log });
  process.exit(code);
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === "exec") {
    const a = parseExec(argv);
    if (a.prompt !== undefined && !a.inputFormat) return execPrompt(a);
    return execJsonRpc(a);
  }
  if (cmd === "eval") return (await import("../eval/cli.ts")).evalMain(argv);
  if (cmd === "daemon") {
    const i = argv.indexOf("--socket");
    const path = i >= 0 ? resolve(argv[i + 1] ?? fail("--socket needs a value")) : defaultSocketPath();
    const w = argv.indexOf("--ws-port");
    const wsPort = w >= 0 ? Number(argv[w + 1]) : undefined;
    if (w >= 0 && !Number.isInteger(wsPort)) fail("--ws-port needs a port number");
    const d = await startDaemon({ socketPath: path, log, ws: argv.includes("--no-ws") ? false : { port: wsPort } });
    log(`[daemon] listening on ${d.socketPath}`);
    if (d.wsUrl) log(`[daemon] WebSocket on ${d.wsUrl} (token in ${join(rigwellHome(), "daemon.json")})`);
    const stop = () => { d.stop(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (cmd === undefined || cmd === "tui" || cmd.startsWith("-")) return tui(cmd === "tui" ? argv : cmd === undefined ? [] : [cmd, ...argv]);
  log(USAGE);
  process.exit(2);
}

main();
