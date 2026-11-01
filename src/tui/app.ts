// TUI controller: terminal I/O around the pure reducer and renderer. Talks to a session over an SDK Transport
// (in-process by default, or a daemon socket / WebSocket).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient } from "../sdk/client.ts";
import type { Transport } from "../sdk/transport.ts";
import { listSessions } from "../storage/transcript.ts";
import { parseKeys, PASTE_OFF, PASTE_ON } from "./keys.ts";
import { render, stripAnsi } from "./render.ts";
import { initialState, reduce } from "./reducer.ts";
import type { Effect, TuiEvent, TuiState } from "./types.ts";

export interface TuiOptions {
  cwd: string;
  makeTransport: () => Promise<Transport>;
  /** initialize_session params (modelId, autonomyLevel, interactionMode, skipPermissionsUnsafe...). */
  sessionParams?: Record<string, unknown>;
  version?: string;
  homeDir?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  log?: (m: string) => void;
}

export async function runTui(opts: TuiOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const tty = !!stdout.isTTY && !!stdin.isTTY;
  let cwd = resolve(opts.cwd);
  let state: TuiState = initialState({
    version: opts.version, cwd, homeDir: opts.homeDir, idPrefix: `tui-${crypto.randomUUID().slice(0, 8)}`,
    agentsMd: existsSync(join(cwd, "AGENTS.md")), theme: "dark",
  });
  let client: RpcClient | undefined;
  let reqN = 0;
  const waiting = new Map<string, (result: unknown) => void>();
  let renderQueued = false;
  let done: (code: number) => void;
  const exited = new Promise<number>((r) => (done = r));
  let finishing = false;

  const color = tty && !process.env.NO_COLOR;
  const draw = () => {
    renderQueued = false;
    if (!tty) return;
    const scr = render(state, { width: stdout.columns || 80, height: stdout.rows || 24, color });
    let out = "\x1b[?25l\x1b[H" + scr.lines.map((l) => l + "\x1b[K").join("\r\n");
    if (scr.cursor) out += `\x1b[${scr.cursor.row + 1};${scr.cursor.col + 1}H\x1b[?25h`;
    stdout.write(out);
  };
  const schedule = () => { if (!renderQueued) { renderQueued = true; setImmediate(draw); } };

  function dispatch(e: TuiEvent) {
    const step = reduce(state, e);
    state = step.state;
    for (const eff of step.effects) void run(eff);
    schedule();
    if (state.quit && !finishing) void finish(0);
  }
  const info = (text: string, level: "info" | "error" = "info") => dispatch({ type: "info", text, level });
  const errText = (e: unknown) => String((e as Error)?.message ?? e);

  async function connect(params: Record<string, unknown>, load?: string) {
    const prev = client;
    client = undefined;
    if (prev) {
      await prev.request("close_session", { reason: "clear" }).catch(() => {});
      await prev.close().catch(() => {});
    }
    const c = new RpcClient(await opts.makeTransport());
    client = c;
    c.onNotification = (method, p) => {
      if (c === client && method === "session_notification" && p.notification) dispatch({ type: "notification", n: p.notification, now: Date.now() });
    };
    c.onRequest = (method, p) => {
      if (method !== "request_permission" && method !== "ask_user" && method !== "pick_options") throw new Error(`Method not found: ${method}`);
      const id = String((p as any).requestId ?? (p as any).toolCallId ?? `req-${++reqN}`);
      return new Promise((res) => { waiting.set(id, res); dispatch({ type: "request", id, method, params: p }); });
    };
    c.onClose = () => { if (c === client && !finishing) dispatch({ type: "disconnected", message: "Connection to the session closed." }); };
    const result = load
      ? await c.request("load_session", { sessionId: load, cwd })
      : await c.request("initialize_session", { machineId: "default", cwd, sessionOriginHint: "tui", ...params });
    dispatch({ type: "session_ready", result, fresh: true });
  }

  /** Switch session; if that fails, say why and start a fresh one so the UI stays usable. */
  async function switchTo(params: Record<string, unknown>, load?: string) {
    try { await connect(params, load); } catch (e) {
      info(`Could not ${load ? "resume " + load : "start a session"}: ${errText(e)}`, "error");
      await connect(opts.sessionParams ?? {}).catch((e2) => info(errText(e2), "error"));
    }
  }

  async function run(eff: Effect): Promise<void> {
    try {
      switch (eff.type) {
        case "send":
          await client!.request("add_user_message", { text: eff.text, messageId: eff.messageId, userMessageSource: "tui" }).catch((e) => {
            info(`Could not send: ${errText(e)}`, "error");
            dispatch({ type: "notification", n: { type: "agent_turn_completed", reason: "error" }, now: Date.now() });
          });
          return;
        case "interrupt": await client?.request("interrupt_session", {}).catch(() => {}); return;
        case "settings": await client?.request("update_session_settings", eff.patch).catch((e) => info(`Settings: ${errText(e)}`, "error")); return;
        case "answer": {
          const f = waiting.get(eff.requestId);
          if (f) { waiting.delete(eff.requestId); f(eff.result); }
          return;
        }
        case "quit": void finish(0); return;
        case "new_session": {
          if (eff.cwd) {
            const next = resolve(cwd, eff.cwd);
            if (!existsSync(next) || !statSync(next).isDirectory()) return info(`Not a folder: ${next}`, "error");
            cwd = next;
            state = { ...state, cwd };
          }
          await switchTo(opts.sessionParams ?? {});
          return;
        }
        case "resume": await switchTo({}, eff.sessionId); return;
        case "list_sessions": {
          const list = listSessions(cwd).map((x) => ({ id: x.id, title: x.title, updatedAt: new Date(x.mtimeMs).toISOString() }));
          dispatch({ type: "sessions", sessions: list });
          return;
        }
        case "fetch_context": {
          const stats = await client?.request("get_context_stats", {}).catch(() => null);
          if (stats) dispatch({ type: "context_stats", stats, show: eff.show });
          else if (eff.show) info("Context stats are not available.", "error");
          return;
        }
        case "shell": {
          const p = spawn(Bun.which("bash") ? "bash" : "sh", ["-c", eff.command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (out += d));
          p.on("close", (code) => {
            const lines = out.trimEnd().split("\n");
            const shown = lines.length > 40 ? [...lines.slice(0, 20), `... ${lines.length - 40} lines omitted ...`, ...lines.slice(-20)] : lines;
            info(`${shown.join("\n")}${out ? "\n" : ""}(exit ${code})`);
          });
          p.on("error", (e) => info(`Shell: ${errText(e)}`, "error"));
          return;
        }
        case "files": {
          const q = eff.query;
          const slash = q.lastIndexOf("/");
          const dirPart = slash >= 0 ? q.slice(0, slash + 1) : "";
          const base = q.slice(slash + 1).toLowerCase();
          let items: string[] = [];
          try {
            items = readdirSync(resolve(cwd, dirPart), { withFileTypes: true })
              .filter((d) => !d.name.startsWith(".git") && d.name !== "node_modules" && d.name.toLowerCase().startsWith(base) && (base || !d.name.startsWith(".")))
              .map((d) => dirPart + d.name + (d.isDirectory() ? "/" : ""))
              .sort().slice(0, 8);
          } catch {}
          dispatch({ type: "file_matches", query: q, items });
          return;
        }
        case "copy":
          if (tty) stdout.write(`\x1b]52;c;${Buffer.from(eff.text).toString("base64")}\x07`);
          return;
        case "editor": {
          if (!tty) return;
          const dir = mkdtempSync(join(tmpdir(), "rigwell-tui-"));
          const file = join(dir, "input.md");
          writeFileSync(file, eff.text);
          leaveTerminal();
          const ed = process.env.VISUAL || process.env.EDITOR || "vi";
          spawnSync(ed, [file], { stdio: "inherit", shell: true });
          enterTerminal();
          dispatch({ type: "editor_result", text: readFileSync(file, "utf8").replace(/\n$/, "") });
          return;
        }
        case "rpc": {
          try {
            const r = await client!.request(eff.method, eff.params);
            info(`${eff.label}: done`);
            if (eff.after === "resume_new" && r?.newSessionId) await switchTo({}, r.newSessionId);
          } catch (e) {
            info(`/${eff.label}: ${errText(e)}`, "error");
          }
          return;
        }
      }
    } catch (e) {
      info(errText(e), "error");
    }
  }

  const onResize = () => schedule();
  function enterTerminal() {
    if (!tty) return;
    stdout.write("\x1b[?1049h" + PASTE_ON + "\x1b[2J");
    stdin.setRawMode(true);
    schedule();
  }
  function leaveTerminal() {
    if (!tty) return;
    stdin.setRawMode(false);
    stdout.write(PASTE_OFF + "\x1b[?25h\x1b[?1049l");
  }

  const timer = tty ? setInterval(() => { if (state.running) dispatch({ type: "tick", now: Date.now() }); }, 1000) : undefined;

  async function finish(code: number) {
    if (finishing) return;
    finishing = true;
    if (timer) clearInterval(timer);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    leaveTerminal();
    const c = client;
    client = undefined;
    for (const f of waiting.values()) f({ selectedOption: "cancel", cancelled: true, answers: [], selectedIds: [] });
    waiting.clear();
    if (c) {
      await Promise.race([c.request("close_session", { reason: "prompt_input_exit" }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      await c.close().catch(() => {});
    }
    if (!tty) {
      const scr = render(state, { width: 100, height: Math.max(24, state.items.length * 3 + 14), color: false });
      stdout.write(scr.lines.map((l) => stripAnsi(l).trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
    }
    done(code);
  }

  function onData(chunk: Buffer | string) {
    for (const key of parseKeys(chunk.toString())) dispatch({ type: "key", key, now: Date.now() });
  }

  try {
    await connect(opts.sessionParams ?? {});
  } catch (e) {
    leaveTerminal();
    process.stderr.write(`rigwell: could not start a session: ${errText(e)}\n`);
    return 1;
  }
  enterTerminal();
  stdin.on("data", onData);
  stdout.on("resize", onResize);
  stdin.on("end", () => {
    // Piped input ended: let a running turn finish, then exit.
    const wait = setInterval(() => {
      if (state.panels.length) dispatch({ type: "key", key: { name: "esc" }, now: Date.now() });
      if (!state.running && !state.panels.length) { clearInterval(wait); void finish(0); }
    }, 50);
  });
  if (!tty) stdin.resume();
  process.once("SIGTERM", () => void finish(143));
  return exited;
}
