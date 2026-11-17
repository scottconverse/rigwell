// One benchmark run: fresh copy of a task repo, one prompt, every JSON-RPC message saved, then graded.
// Usage: node run.mjs --task T1 --mode script_only|direct_only|none --model claude-opus-5-5 --effort high
//          --id <runId> [--exec <droid.exe>] [--timeout-min 15] [--env K=V ...] [--no-grade] [--prompt "<text>"]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessTransport, createSession } from '@factory/droid-sdk/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(here, '..');
const a = { mode: 'none', effort: 'high', 'timeout-min': '15', env: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (k === 'no-grade') { a[k] = true; continue; }
  const v = process.argv[++i];
  if (k === 'env') a.env.push(v); else a[k] = v;
}
const runDir = path.join(BENCH, 'runs', a.id);
const work = path.join(runDir, 'work');
fs.rmSync(runDir, { recursive: true, force: true });
fs.mkdirSync(runDir, { recursive: true });
fs.cpSync(path.join(BENCH, 'tasks', a.task, 'repo'), work, { recursive: true });
const prompt = a.prompt ?? fs.readFileSync(path.join(BENCH, 'tasks', a.task, 'prompt.txt'), 'utf8');

const rawLog = fs.createWriteStream(path.join(runDir, 'jsonrpc.jsonl'));
const t0 = Date.now();
const log = (dir, m) => rawLog.write(JSON.stringify({ t: Date.now() - t0, dir, m }) + '\n');
const env = Object.fromEntries(a.env.map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));

const inner = new ProcessTransport({ droidExecPath: a.exec, cwd: work, env });
await inner.connect();
const transport = {
  async send(m) {
    if (m?.method === 'droid.initialize_session' && a.mode !== 'none') m.params.toolExecutionMode = a.mode;
    log('out', m);
    return inner.send(m);
  },
  onMessage(h) { inner.onMessage((m) => { log('in', m); h(m); }); },
  onError(h) { inner.onError(h); },
  close() { return inner.close(); },
  get isConnected() { return inner.isConnected; },
};

const summary = { id: a.id, task: a.task, mode: a.mode, model: a.model, effort: a.effort, started: new Date().toISOString() };
const tools = {}, types = {}, usageUpdates = [];
let result = null, errors = [];
let timedOut = false;
let session;
try {
  session = await createSession({
    transport, cwd: work, modelId: a.model, reasoningEffort: a.effort,
    autonomyLevel: 'medium', autoRejectPermissionRequests: true,
  });
  summary.settings = session.settings;
  const timer = setTimeout(() => { timedOut = true; session.interrupt().catch(() => {}); }, Number(a['timeout-min']) * 60000);
  for await (const msg of session.stream(prompt)) {
    types[msg.type] = (types[msg.type] ?? 0) + 1;
    if (msg.type === 'token_usage_update') usageUpdates.push(msg);
    if (msg.type === 'tool_call') tools[msg.name] = (tools[msg.name] ?? 0) + 1;
    if (msg.type === 'error') errors.push(msg.message);
    if (msg.type === 'result') result = msg;
  }
  clearTimeout(timer);
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  summary.wall_ms = Date.now() - t0;
  try { await session?.close(); } catch {}
  try { await transport.close(); } catch {}
  rawLog.end();
}
summary.timedOut = timedOut;
summary.toolCalls = tools;
summary.messageTypes = types;
summary.usageUpdates = usageUpdates;
summary.errors = errors;
summary.result = result;
if (!a['no-grade']) {
  const g = spawnSync('python', ['-I', path.join(BENCH, 'grade.py'), path.join(BENCH, 'tasks'), a.task, work], { encoding: 'utf8' });
  try { summary.grade = JSON.parse(g.stdout.trim().split('\n').pop()); } catch { summary.grade = { error: g.stdout + g.stderr }; }
}
fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ id: a.id, passed: summary.grade?.passed, wall_ms: summary.wall_ms, tools, usage: result?.tokenUsage, errors: errors.map((e) => e.slice(0, 300)) }));
process.exit(0);
