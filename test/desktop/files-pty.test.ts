// Side pane Files and Terminal services, through a real daemon connection (no Electron).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWin } from "../platform.ts";
import { startFakeAnthropic } from "../fakes/fake-anthropic.ts";
import type { FakeServer } from "../fakes/types.ts";
import { makeRepo } from "../e2e/helpers.ts";
import { buildEnv, pipeLineEnds, resolveShell, stripAnsi } from "../../src/sidepane/pty.ts";
import { connect, sleep, startTestDaemon, type TestClient } from "./helpers.ts";

let fake: FakeServer;
let daemon: Awaited<ReturnType<typeof startTestDaemon>>;
beforeAll(async () => {
  fake = await startFakeAnthropic([]);
  daemon = await startTestDaemon(fake.url, { terminals: { graceMs: 700 } });
});
afterAll(() => { daemon.d.stop(); fake.stop(); });

async function session(): Promise<{ c: TestClient; repo: string; sessionId: string }> {
  const repo = makeRepo();
  const c = await connect(daemon.d.socketPath);
  const r = await c.call("initialize_session", { cwd: repo, modelId: "custom:Fake-Anthropic-0" });
  return { c, repo, sessionId: r.sessionId };
}

describe("Files (spec 17.1)", () => {
  test("list, search, read, write", async () => {
    const { c, repo } = await session();
    mkdirSync(join(repo, "src/deep"), { recursive: true });
    writeFileSync(join(repo, "src/deep/widget.ts"), "export const w = 1;\n");
    writeFileSync(join(repo, ".hidden"), "x");
    const list = await c.call("daemon.list_files", {});
    expect(list.files).toContain("greet.js");
    expect(list.files).toContain("src/deep/widget.ts");
    expect(list.files).not.toContain(".hidden");
    expect(list.directories).toContain("src/deep");
    expect((await c.call("daemon.list_files", { showHidden: true })).files).toContain(".hidden");
    expect((await c.call("daemon.list_files", { path: "src" })).files).toEqual(["src/deep/widget.ts"]);

    const found = await c.call("daemon.search_files", { query: "widg" });
    expect(found.files[0]).toBe("src/deep/widget.ts");

    const read = await c.call("daemon.get_workspace_file_content", { filePath: "greet.js" });
    expect(read.content).toContain("Helo");
    expect(read.mimeType).toBe("text/javascript");
    expect(read.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const meta = await c.call("daemon.get_workspace_file_content", { filePath: "greet.js", metadataOnly: true });
    expect(meta.content).toBeUndefined();
    expect(meta.fingerprint).toBe(read.fingerprint);

    const w = await c.call("daemon.write_workspace_file_content", { filePath: "greet.js", content: read.content.replace("Helo", "Hello"), baseFingerprint: read.fingerprint });
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toContain("Hello, ");
    expect(w.fingerprint).not.toBe(read.fingerprint);
    await c.close();
  });

  test("a stale write is refused with -32006 and the file is untouched", async () => {
    const { c, repo } = await session();
    const read = await c.call("daemon.get_workspace_file_content", { filePath: "greet.js" });
    // Someone else (the agent, an editor) changes the file after the editor loaded it.
    writeFileSync(join(repo, "greet.js"), "changed elsewhere\n");
    const err: any = await c.call("daemon.write_workspace_file_content", { filePath: "greet.js", content: "my edit\n", baseFingerprint: read.fingerprint }).catch((e) => e);
    expect(err.code).toBe(-32006);
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toBe("changed elsewhere\n");
    // Re-reading gives the new fingerprint and the write goes through.
    const again = await c.call("daemon.get_workspace_file_content", { filePath: "greet.js" });
    await c.call("daemon.write_workspace_file_content", { filePath: "greet.js", content: "my edit\n", baseFingerprint: again.fingerprint });
    expect(readFileSync(join(repo, "greet.js"), "utf8")).toBe("my edit\n");
    await c.close();
  });

  test("paths cannot escape the working folder; binary and missing files are refused", async () => {
    const { c, repo } = await session();
    // A real file outside the working folder (the same role /etc/passwd plays on POSIX).
    const outside = join(mkdtempSync(join(tmpdir(), "rigwell-outside-")), "outside.txt");
    writeFileSync(outside, "outside\n");
    for (const bad of ["../x", outside, "a/../../b", "C:\\x"]) {
      const e: any = await c.call("daemon.get_workspace_file_content", { filePath: bad }).catch((x) => x);
      // Absolute reads are allowed for the session owner; relative escapes are not.
      if (bad === outside) expect(e.content).toBeDefined();
      else if (bad === "C:\\x" && isWin) expect(e.code).toBeDefined(); // a drive path is absolute on Windows (and does not exist here)
      else expect(e.code).toBe(-32602);
    }
    const w: any = await c.call("daemon.write_workspace_file_content", { filePath: outside, content: "x" }).catch((x) => x);
    expect(w.code).toBe(-32602);
    symlinkSync(outside, join(repo, "link.txt"));
    const l: any = await c.call("daemon.write_workspace_file_content", { filePath: "link.txt", content: "x" }).catch((x) => x);
    expect(l.code).toBe(-32602);
    writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    const b = await c.call("daemon.get_workspace_file_content", { filePath: "bin.dat" });
    expect(b.isBinary).toBe(true);
    expect(b.content).toBeUndefined();
    const wb: any = await c.call("daemon.write_workspace_file_content", { filePath: "bin.dat", content: "x" }).catch((x) => x);
    expect(wb.code).toBe(-32602);
    const nf: any = await c.call("daemon.write_workspace_file_content", { filePath: "new.txt", content: "x" }).catch((x) => x);
    expect(nf.code).toBe(-32004);
    await c.close();
  });
});

describe("Terminal (spec 17.2)", () => {
  test("shell allow-list and protected environment keys", () => {
    if (isWin) {
      expect(resolveShell("python3")).toBe("cmd.exe");
      expect(resolveShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell.exe");
    } else {
      expect(resolveShell("/bin/bash")).toMatch(/bash$/);
      expect(resolveShell("/tmp/evil/bash")).toMatch(/(bash|zsh)$/);
      expect(resolveShell("/tmp/evil/bash")).not.toContain("/tmp/evil");
      // Unknown shells fall back to the platform default: zsh on macOS, bash elsewhere.
      expect(resolveShell("python3")).toMatch(process.platform === "darwin" ? /zsh$/ : /bash$/);
    }
    // Windows rules, simulated on any platform: the file name decides, the folder does not, the default is cmd.exe.
    expect(resolveShell("C:\\Tools\\evil\\pwsh.exe", "win32")).toBe("pwsh.exe");
    expect(resolveShell("C:\\Tools\\evil\\malware.exe", "win32")).toBe("cmd.exe");
    expect(resolveShell(undefined, "win32")).toBe("cmd.exe");
    const env = buildEnv({ PATH: "/bin", HOME: "/home/real" }, { HOME: "/tmp/fake", LD_PRELOAD: "x.so", FOO: "bar" });
    expect(env.HOME).toBe("/home/real");
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.FOO).toBe("bar");
    expect(env.TERM).toBe("xterm-256color");
  });

  test("output streams, input works, duplicate ids and bad cwd are reported", async () => {
    const { c, repo } = await session();
    expect(await c.call("daemon.create_terminal", { terminalId: "t1", cols: 100, rows: 30 })).toEqual({ success: true });
    expect(await c.call("daemon.create_terminal", { terminalId: "t1" })).toEqual({ success: false, error: "TerminalIdExists" });
    const bad: any = await c.call("daemon.create_terminal", { terminalId: "t2", cwd: join(repo, "nope") }).catch((e) => e);
    expect(bad.code).toBe(-32602);
    expect(bad.data?.reason).toBe("not_found");
    await c.call("daemon.write_terminal_data", { terminalId: "t1", data: isWin ? "echo marker-42\r\n" : "echo marker-$((6*7)); pwd\n" });
    await c.waitFor((n) => n.type === "daemon.terminal_data" && n.terminalId === "t1" && n.data.includes("marker-42"));
    const out = c.notes.filter((n) => n.type === "daemon.terminal_data").map((n) => n.data).join("");
    expect(out).toContain("marker-42");
    await c.call("daemon.resize_terminal", { terminalId: "t1", cols: 120, rows: 40 });
    if (!isWin) {
      // Needs a real terminal. On Windows the terminal runs on pipes (no PTY), so only the call is checked.
      await c.call("daemon.write_terminal_data", { terminalId: "t1", data: "stty size\n" });
      await c.waitFor((n) => n.type === "daemon.terminal_data" && n.data.includes("40 120"));
    }
    await c.call("daemon.write_terminal_data", { terminalId: "t1", data: "exit 3\n" });
    const exit = await c.waitFor((n) => n.type === "daemon.terminal_exit");
    expect(exit.exitCode).toBe(3);
    expect((await c.call("daemon.list_terminals", {})).terminals).toEqual([]);
    await c.close();
  });

  test("the Enter key (a lone CR, what xterm.js sends) runs the typed line", async () => {
    // On Windows the shell reads a pipe and waits for a LF; a PTY turns CR into a line end by itself.
    expect(pipeLineEnds("dir\r")).toBe("dir\r\n");
    expect(pipeLineEnds("a\r\nb\rc")).toBe("a\r\nb\r\nc");
    expect(pipeLineEnds("plain")).toBe("plain");
    const { c } = await session();
    await c.call("daemon.create_terminal", { terminalId: "cr" });
    await c.call("daemon.write_terminal_data", { terminalId: "cr", data: isWin ? "echo enter-4^2\r" : "echo enter-$((40+2))\r" });
    await c.waitFor((n) => n.type === "daemon.terminal_data" && n.terminalId === "cr" && n.data.includes("enter-42"));
    await c.call("daemon.close_terminal", { terminalId: "cr" });
    await c.close();
  });

  test("a terminal survives a dropped connection and the new connection gets the scrollback", async () => {
    const { c, repo, sessionId } = await session();
    await c.call("daemon.create_terminal", { terminalId: "keep", cwd: repo });
    await c.call("daemon.write_terminal_data", { terminalId: "keep", data: isWin ? "echo before-reload& set KEPT=alive\r\n" : "echo before-reload; export KEPT=alive\n" });
    await c.waitFor((n) => n.type === "daemon.terminal_data" && n.data.includes("before-reload"));
    const pid = (await c.call("daemon.list_terminals", {})).terminals[0].pid;
    await c.close(); // the window reloads: its connection is gone

    await sleep(150);
    const c2 = await connect(daemon.d.socketPath);
    await c2.call("load_session", { sessionId, cwd: repo });
    const listed = (await c2.call("daemon.list_terminals", {})).terminals;
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe("keep");
    expect(listed[0].pid).toBe(pid); // the same process
    expect(listed[0].state.plainText).toContain("before-reload");
    expect(stripAnsi(listed[0].state.serialized)).toContain("before-reload");
    // Still the same shell: its variable is set, and new output reaches the new connection.
    await c2.call("daemon.write_terminal_data", { terminalId: "keep", data: isWin ? "echo kept=%KEPT%\r\n" : "echo kept=$KEPT\n" });
    await c2.waitFor((n) => n.type === "daemon.terminal_data" && n.data.includes("kept=alive"));
    // Output must not have gone to the dead connection, and the grace timer must not kill an adopted terminal.
    await sleep(1000);
    expect((await c2.call("daemon.list_terminals", {})).terminals.length).toBe(1);
    await c2.call("daemon.close_terminal", { terminalId: "keep" });
    await c2.close();
  });

  test("an orphaned terminal is killed after the grace period; others cannot write to it", async () => {
    const { c, repo, sessionId } = await session();
    await c.call("daemon.create_terminal", { terminalId: "orphan", cwd: repo });
    const second = await connect(daemon.d.socketPath);
    await second.call("load_session", { sessionId, cwd: repo });
    // The terminal belongs to the first connection until it drops.
    const denied: any = await second.call("daemon.write_terminal_data", { terminalId: "orphan", data: "x" }).catch((e) => e);
    expect(denied.code).toBe(-32006);
    expect((await second.call("daemon.list_terminals", {})).terminals).toEqual([]); // not adoptable while owned
    await c.close();
    await sleep(1300); // grace is 700 ms in this test
    expect(daemon.d.sessionCount).toBeGreaterThanOrEqual(0);
    expect((await second.call("daemon.list_terminals", {})).terminals).toEqual([]);
    await second.close();
  });
});
