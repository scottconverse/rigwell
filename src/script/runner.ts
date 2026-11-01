// Sandbox runner: runs in its own child process (spawned by sandbox.ts). It evaluates the model's
// program inside a QuickJS (WebAssembly) context. The guest has NO host access at all: no module
// loader, no process, no fs, no network, no timers. The only channels out are the host functions
// installed below (call, print, image, notify), and each of them only emits a JSON line on stdout.
// Tool calls are answered by the parent over stdin. See docs/decisions.md (Phase 2).
import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSDeferredPromise } from "quickjs-emscripten";

const BOOTSTRAP = `(function (call, print, image, notify, toolNames) {
  'use strict';
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (v instanceof Error) return String(v && v.stack ? v.stack : v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  };
  const invoke = async (name, input) => {
    const r = JSON.parse(await call(name, JSON.stringify(input === undefined ? {} : input)));
    if (!r.ok) { const e = new Error(r.error.message); e.name = r.error.name || 'Error'; throw e; }
    return r.value;
  };
  const bound = {};
  for (const n of toolNames) bound[n] = (input) => invoke(n, input);
  // Tools loaded later (deferred tools) are not in the list above: any other name is forwarded to the host,
  // which rejects it unless it is a loaded tool. tools.server.tool calls the tool named server__tool.
  const nested = (path) => new Proxy(function () {}, {
    get(_t, p) { return typeof p === 'string' && p !== 'then' ? nested(path.concat(p)) : undefined; },
    apply(_t, _this, args) { return invoke(path.join('__'), args[0]); },
  });
  const tools = new Proxy(bound, {
    get(t, p) {
      if (typeof p !== 'string' || p === 'then') return undefined;
      return Object.prototype.hasOwnProperty.call(t, p) ? t[p] : nested([p]);
    },
    set() { return false; }, defineProperty() { return false; }, deleteProperty() { return false; },
  });
  const results = {
    search: (query, opts) => invoke('__results_search', { query, opts: opts || {} }),
    get: (job_id, callNo) => invoke('__results_get', { job_id, call: callNo }),
  };
  Object.freeze(results);
  const g = globalThis;
  g.tools = tools; g.results = results;
  g.print = (...vals) => { print(vals.map(fmt).join(' ')); };
  g.image = (data, mime) => { image(String(data), String(mime)); };
  g.notify = (text) => { notify(String(text)); };
})`;

const out = (m: Record<string, unknown>) => { process.stdout.write(JSON.stringify(m) + "\n"); };

/**
 * Exit once everything written to stdout has been handed to the pipe. A bare process.exit(0) right after a large
 * burst of output (the pipe is full while the host is busy) drops the tail and the final "done" message.
 */
const exitAfterFlush = () => { process.stdout.write("", () => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };

interface RunMsg {
  type: "run"; code: string; inputs: Record<string, string>; toolNames: string[];
  memoryBytes: number; stackBytes: number; sliceMs: number;
}

const pending = new Map<number, QuickJSDeferredPromise>();
let nextId = 1;
let wake: (() => void) | undefined;
let ctx: QuickJSContext | undefined;

async function run(msg: RunMsg) {
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(msg.memoryBytes);
  rt.setMaxStackSize(msg.stackBytes);
  let sliceStart = Date.now();
  // Stops a synchronous slice (e.g. an endless loop) once it has run past its limit.
  rt.setInterruptHandler(() => Date.now() - sliceStart > msg.sliceMs);
  const c = rt.newContext();
  ctx = c;
  const str = (h: QuickJSHandle) => c.getString(h);
  const callFn = c.newFunction("call", (nameH, jsonH) => {
    const id = nextId++;
    const d = c.newPromise();
    pending.set(id, d);
    out({ type: "call", id, name: str(nameH), input: str(jsonH) });
    return d.handle;
  });
  const printFn = c.newFunction("print", (h) => { out({ type: "print", text: str(h) }); });
  const imageFn = c.newFunction("image", (d, m) => { out({ type: "image", data: str(d), mime: str(m) }); });
  const notifyFn = c.newFunction("notify", (h) => { out({ type: "notify", text: str(h) }); });
  const fail = (err: QuickJSHandle) => out({ type: "done", ok: false, error: c.dump(err) });

  const setup = c.evalCode(`(${BOOTSTRAP})`);
  if (setup.error) return fail(setup.error);
  // Tool names and inputs are handed over as JSON text and parsed inside the guest.
  const parse = c.evalCode("(s) => JSON.parse(s)").unwrap();
  const namesArr = c.callFunction(parse, c.undefined, c.newString(JSON.stringify(msg.toolNames))).unwrap();
  // The bootstrap receives the host functions as arguments, so they never become globals.
  const boot = c.callFunction(setup.value, c.undefined, callFn, printFn, imageFn, notifyFn, namesArr);
  if (boot.error) return fail(boot.error);
  const setInputs = c.evalCode("(s) => { globalThis.inputs = Object.freeze(JSON.parse(s)); }").unwrap();
  c.callFunction(setInputs, c.undefined, c.newString(JSON.stringify(msg.inputs))).unwrap();

  sliceStart = Date.now();
  // The program is an async module body: top-level await works.
  const res = c.evalCode(`(async function(){${msg.code}\n})()`, "script.js");
  if (res.error) return fail(res.error);
  const promise = res.value;
  for (;;) {
    sliceStart = Date.now();
    const jobs = rt.executePendingJobs();
    if (jobs.error) return fail(jobs.error);
    const st = c.getPromiseState(promise);
    if (st.type === "fulfilled") return void out({ type: "done", ok: true });
    if (st.type === "rejected") return fail(st.error);
    if (jobs.value > 0) continue;
    if (pending.size === 0) {
      return void out({ type: "done", ok: false, error: { name: "Error", message: "The Script ended while still waiting on a promise that can never resolve." } });
    }
    await new Promise<void>((r) => { wake = r; });
  }
}

let buf = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "run" && !started) {
      started = true;
      run(m).then(
        () => exitAfterFlush(),
        (e) => { out({ type: "done", ok: false, error: { name: "Error", message: String(e?.message ?? e) } }); exitAfterFlush(); },
      );
    } else if (m.type === "reply") {
      const d = pending.get(m.id);
      if (d && ctx) {
        pending.delete(m.id);
        d.resolve(ctx.newString(JSON.stringify(m.payload)));
        wake?.();
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
