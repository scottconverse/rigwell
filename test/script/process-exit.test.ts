// session_process_exited (spec 19.1): the Script sandbox process dying on its own is reported; a normal run, a stop and a timeout are not.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScript } from "../../src/script/parse.ts";
import { ResultLog } from "../../src/script/resultlog.ts";
import { ScriptRun } from "../../src/script/run.ts";
import { call, makeStubSession, text } from "../agent/helpers.ts";

beforeAll(() => { process.env.RIGWELL_HOME = mkdtempSync(join(tmpdir(), "rigwell-exit-home-")); });

let seq = 0;
function start(code: string, exits: string[], hang?: Promise<void>) {
  const parsed = parseScript(code);
  if ("error" in parsed) throw new Error(parsed.error);
  const sessionId = `x-${++seq}`;
  const r = new ScriptRun({
    jobId: `scr_x${seq}`, runId: `runx-${seq}`, outerId: `outerx-${seq}`, sessionId, parsed, toolNames: ["Read"], resultLog: new ResultLog(sessionId),
    host: { cwd: "/tmp", notify: () => {}, processExited: (m) => exits.push(m), callTool: async () => { await hang; return { content: "{}" }; } },
  });
  r.start();
  return r;
}

test("a sandbox process killed from outside is reported once, and the run fails", async () => {
  const exits: string[] = [];
  let release!: () => void;
  const r = start("await tools.Read({});", exits, new Promise<void>((res) => (release = res)));
  for (let i = 0; i < 400 && !(r as any).sandbox.proc; i++) await Bun.sleep(5);
  await Bun.sleep(300); // the program is parked on the tool call
  (r as any).sandbox.proc.kill("SIGKILL");
  await r.done;
  release();
  expect(exits).toEqual(["The Script sandbox process exited unexpectedly."]);
  expect((r.report() as any).status).not.toBe("completed");
});

test("a normal finish and a stop do not report an exit", async () => {
  const exits: string[] = [];
  const ok = start("print('hi')", exits);
  await ok.done;
  const stopped = start("await tools.Read({});", exits, new Promise(() => {}));
  await Bun.sleep(200);
  stopped.stop();
  await stopped.done;
  await Bun.sleep(100);
  expect(exits).toEqual([]);
});

test("the session forwards it as a session_process_exited notification", async () => {
  const { session, notes } = makeStubSession((req, n) => (n === 0 ? call("Script", { script: "await tools.Execute({ command: 'sleep 5', riskLevel: 'low', riskReason: 'wait' });" }) : text("done")));
  session.addUserMessage("run it");
  // Kill the runner process the Script spawned.
  for (let i = 0; i < 400; i++) {
    const proc = (session as any).jobs.list().map((j: any) => j.sandbox?.proc).find(Boolean);
    if (proc) { await Bun.sleep(300); proc.kill("SIGKILL"); break; }
    await Bun.sleep(10);
  }
  await session.idle();
  const ev = notes.filter((n) => n.type === "session_process_exited");
  expect(ev).toHaveLength(1);
  expect(ev[0].message).toContain("sandbox process exited unexpectedly");
  expect(typeof ev[0].timestamp).toBe("string");
});
