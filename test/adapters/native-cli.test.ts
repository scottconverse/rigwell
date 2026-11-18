import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCliAdapter, nativeEnvironment, nativeArguments, nativePrompt } from "../../src/adapters/native-cli.ts";
import { validateCustomModels } from "../../src/storage/models.ts";
import { model, request, userMsg, collect, done } from "./helpers.ts";
import { makeStubSession } from "../agent/helpers.ts";
import { streamWithRetry } from "../../src/adapters/retry.ts";
import { createAutomationService, automationTools } from "../../src/automations/index.ts";
import { tmpEnv } from "../storage/helpers.ts";
import { createWorkstreamService } from "../../src/workstreams/index.ts";
import { WorkstreamStore } from "../../src/workstreams/store.ts";
import { until } from "../workstreams/helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "rigwell-native-"));
const fixture = join(dir, "client.js");
writeFileSync(fixture, `
const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_API?'api_key':'claude.ai',subscriptionType:'max'}));process.exit(0)}
if(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(process.env.FAKE_NATIVE_PERMISSION){
 const flag=args.indexOf('--permission-prompt-tool');
 if(flag<0){console.log(JSON.stringify({type:'result',subtype:'success',result:'Command requires approval; it did not run.'}));process.exit(0)}
 const config=JSON.parse(await Bun.file(args[args.indexOf('--mcp-config')+1]).text()),server=config.mcpServers.rigwell;
 const result=await(await fetch(server.url,{method:'POST',headers:{authorization:server.headers.Authorization,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:args[flag+1].replace('mcp__rigwell__',''),arguments:{tool_name:'Bash',input:{command:'npm test',description:'Run the workspace tests'}}}})})).json();
 const decision=JSON.parse(result.result.content[0].text);
 if(decision.behavior==='allow')await Bun.write('approved-marker.txt','approved');
 console.log(JSON.stringify({type:'result',subtype:'success',result:decision.behavior==='allow'?'Approved command ran.':'Command denied; it did not run.'}));process.exit(0);
}
if(process.env.FAKE_BRIDGE){
 let url,token;
 if(args[0]==='exec'){
  url=JSON.parse(args.find(a=>a.startsWith('mcp_servers.rigwell.url=')).split('=').slice(1).join('='));
  token=process.env.RIGWELL_COORDINATION_TOKEN;
 }else{
  const config=JSON.parse(await Bun.file(args[args.indexOf('--mcp-config')+1]).text());
  url=config.mcpServers.rigwell.url;token=config.mcpServers.rigwell.headers.Authorization.slice(7);
 }
 const call=async(method,params={})=>(await(await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());
 if(process.env.FAKE_NEXT){
  const current=prompt.split('Current user request:\\n').at(-1);
  if(current==='VERIFY_NEXT_HISTORY'){
   await Bun.write('native-history.txt',prompt);
  }else if(current==='RUN_NATIVE_ONLY'){
   await Bun.write('native-only-live.txt','ready');
   const end=Date.now()+5000;
   while(!(await Bun.file('release-native-only.txt').exists())){
    if(Date.now()>=end)process.exit(16);
    await Bun.sleep(5);
   }
  }else if(current.includes('NATIVE_STDIN_BODY')){
   await Bun.write('native-stdin.txt',current);
   const handoff=await call('tools/call',{name:'ListAgents',arguments:{}});
   await Bun.write('native-backlog.json',JSON.stringify(handoff.result.content));
  }else if(current==='RUN_NEXT_WAIT'){
   const first=await call('tools/call',{name:'WaitForEvents',arguments:{timeoutMs:5000}});
   const second=await call('tools/call',{name:'ListAgents',arguments:{}});
   await Bun.write('native-next.json',JSON.stringify({first:first.result.content,second:second.result.content}));
  }
 }else{
 const tool=process.env.FAKE_TOOL||(process.env.FAKE_ASK?'AskUser':'ListAgents');
 const listed=await call('tools/list');if(!listed.result.tools.some(t=>t.name===tool))process.exit(12);
 if(args[0]==='exec'&&!args.includes('mcp_servers.rigwell.tools.'+tool+'.approval_mode="approve"'))process.exit(14);
 const result=await call('tools/call',{name:tool,arguments:process.env.FAKE_INPUT?JSON.parse(process.env.FAKE_INPUT):process.env.FAKE_ASK?{questions:[{topic:'Fixture',question:'Which fixture?',options:['one','two']}]}:{}});
 if(process.env.FAKE_EXPECT_DENIED){if(!result.result.isError)process.exit(15)}
 else if(!result.result.content[0].text.includes(process.env.FAKE_EXPECT_TEXT||'fixture-roster'))process.exit(13);
 }
}
if(process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY)process.exit(9);
if(process.env.FAKE_BAD){console.log('not-json');process.exit(0)}
if(process.env.FAKE_FAIL){console.log(JSON.stringify({type:'turn.failed',error:{message:'failed'}}));process.exit(0)}
if(process.env.FAKE_METRICS){
 const emit=e=>console.log(JSON.stringify(e));
 if(args[0]==='exec'){
  emit({type:'item.started',item:{id:'one',type:'command_execution',command:'PRIVATE_ARGUMENT'}});
  emit({type:'item.completed',item:{id:'one',type:'command_execution',exit_code:1,status:'completed',aggregated_output:'PRIVATE_RESULT'}});
  emit({type:'item.completed',item:{id:'two',type:'file_change',status:'completed'}});
  emit({type:'item.started',item:{id:'three',type:'web_search'}});
  emit({type:'item.started',item:{id:'bridge',type:'mcp_tool_call',server:'rigwell',tool:'ListAgents'}});
  emit({type:'item.completed',item:{id:'bridge',type:'mcp_tool_call',server:'rigwell',tool:'ListAgents',status:'completed'}});
 }else{
  for(const [id,name] of [['one','Bash'],['two','Read'],['three','Read'],['bridge','mcp__rigwell__ListAgents']])emit({type:'assistant',message:{content:[{type:'tool_use',id,name,input:{path:'PRIVATE_ARGUMENT'}}]}});
  for(const [id,is_error] of [['one',true],['two',false],['bridge',false]])emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error,content:'PRIVATE_RESULT'}]}});
 }
 if(process.env.FAKE_METRICS_FAIL){emit({type:'turn.failed',error:{message:'failed after tools'}});process.exit(0)}
}
if(args[0]==='exec'){
 console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));
 if(process.env.FAKE_WAIT)await new Promise(r=>setTimeout(r,30000));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3}}));
}else{
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Read'}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',result:'done',usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:5}}));
}
`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const req = (backend: "claude-cli" | "codex-cli") => request(model(backend === "claude-cli" ? "anthropic" : "openai", "", { apiKey: undefined, executionBackend: backend }), [userMsg("Read and fix the requested file")], { nativeExecution: { cwd: dir, readOnly: false, skipPermissions: false } });
const adapter = (env: NodeJS.ProcessEnv = {}) => new NativeCliAdapter({ command: [process.execPath, fixture], env: { ...process.env, ...env } });

for (const backend of ["claude-cli", "codex-cli"] as const) {
  test(`${backend}: a waiting native lead receives a Next body with its listener result, once`, async () => {
    const env = tmpEnv();
    const service = createWorkstreamService({ recover: false });
    const request = async () => ({ selectedOption: "proceed_once" });
    const notes: any[] = [];
    const s = makeStubSession(() => { throw new Error("native client only"); }, {
      notes,
      resolveModel: () => req(backend).model,
      createAdapter: () => adapter({ FAKE_BRIDGE: "1", FAKE_NEXT: "1" }), streamWithRetry,
      toolsFor: (_ctx) => attached.wrapTools([]),
    }, { requestPermission: request, notify: (n) => { notes.push(n); service.observe(s.session, n); } });
    const conn = { session: () => s.session, notify() {}, request };
    const attached = service.attach(conn);
    try {
      const proposal = await service.propose(conn, { title: "Native handoff", goal: "Exchange task data", plan: "Wait for the next message" });
      expect(proposal.accepted).toBe(true);
      const store = new WorkstreamStore(proposal.workstreamId!);
      service.listeners.create(store, "lead", { on: "message" });
      s.session.addUserMessage("RUN_NEXT_WAIT");
      await until(() => s.notes.some((n) => n.type === "tool_call" && n.toolUse.name === "WaitForEvents"));
      const sent = attached.methods.workstream_send({ id: store.id, to: "lead", message: "UNIQUE_NEXT_BODY", priority: "next" });
      const later = attached.methods.workstream_send({ id: store.id, to: "lead", message: "LATER_BODY", priority: "later" });
      expect(store.messages().find((m) => m.id === sent.messageId)).not.toHaveProperty("nativeSubmittedAt");
      await s.session.idle();
      const reply = await Bun.file(join(s.cwd, "native-next.json")).json();
      expect(JSON.parse(reply.first[0].text).events[0].trigger.messageId).toBe(sent.messageId);
      expect(JSON.stringify(reply.first).match(/UNIQUE_NEXT_BODY/g)).toHaveLength(1);
      expect(JSON.stringify(reply.first)).not.toContain("LATER_BODY");
      expect(JSON.stringify(reply.second)).not.toContain("UNIQUE_NEXT_BODY");
      expect(s.session.uiMessages().filter((m) => m.id === sent.messageId)).toHaveLength(1);
      expect(store.messages().find((m) => m.id === sent.messageId)).toHaveProperty("nativeSubmittedAt", expect.any(Number));
      expect(store.messages().find((m) => m.id === later.messageId)).not.toHaveProperty("nativeSubmittedAt");
      expect(s.session.uiMessages().filter((m) => m.id === later.messageId)).toHaveLength(1);
      s.session.addUserMessage("VERIFY_NEXT_HISTORY");
      await s.session.idle();
      expect((await Bun.file(join(s.cwd, "native-history.txt")).text()).match(/UNIQUE_NEXT_BODY/g)).toHaveLength(1);
      s.session.addUserMessage("RUN_NATIVE_ONLY");
      const started = join(s.cwd, "native-only-live.txt");
      await until(() => existsSync(started));
      const nextPrompt = attached.methods.workstream_send({ id: store.id, to: "lead", message: "NATIVE_STDIN_BODY", priority: "next" });
      expect(store.messages().find((m) => m.id === nextPrompt.messageId)).not.toHaveProperty("nativeSubmittedAt");
      const backlog = attached.methods.workstream_send({ id: store.id, to: "lead", message: "NEXT_BACKLOG_BODY", priority: "next" });
      attached.methods.workstream_send({ id: store.id, to: "lead", message: "LATER_BACKLOG_BODY", priority: "later" });
      writeFileSync(join(s.cwd, "release-native-only.txt"), "continue");
      await s.session.idle();
      expect((await Bun.file(join(s.cwd, "native-stdin.txt")).text()).match(/NATIVE_STDIN_BODY/g)).toHaveLength(1);
      expect(store.messages().find((m) => m.id === nextPrompt.messageId)).toHaveProperty("nativeSubmittedAt", expect.any(Number));
      expect(notes.some((n) => n.type === "native_workstream_submitted" && n.boundary === "stdin" && n.messageIds.includes(nextPrompt.messageId))).toBe(true);
      const backlogReply = await Bun.file(join(s.cwd, "native-backlog.json")).text();
      expect(backlogReply.match(/NEXT_BACKLOG_BODY/g)).toHaveLength(1);
      expect(backlogReply).not.toContain("LATER_BACKLOG_BODY");
      expect(s.session.uiMessages().filter((m) => m.id === backlog.messageId)).toHaveLength(1);
      expect(notes.some((n) => n.type === "native_workstream_submitted" && n.boundary === "coordination" && n.messageIds.includes(backlog.messageId))).toBe(true);
    } finally {
      s.session.interrupt(true); await s.session.idle(); attached.close(); await service.stop();
      env.cleanup(); rmSync(s.cwd, { recursive: true, force: true });
    }
  });
}

test("native command approval reaches the owning Session before execution", async () => {
  let approvals = 0;
  const s = makeStubSession(() => { throw new Error("native client only"); }, {
    resolveModel: () => req("claude-cli").model,
    createAdapter: () => adapter({ FAKE_NATIVE_PERMISSION: "1" }), streamWithRetry,
    autoRejectPermissionRequests: false,
  }, { async requestPermission(params: any) {
    approvals++;
    expect(params.toolUses[0].toolUse.input.command).toBe("npm test");
    expect(params.options.map((o: any) => o.value)).toEqual(["proceed_once", "cancel"]);
    expect(await Bun.file(join(s.cwd, "approved-marker.txt")).exists()).toBe(false);
    return { selectedOption: "proceed_once" };
  } });
  try {
    s.session.addUserMessage("Run the workspace tests"); await s.session.settled();
    expect(approvals).toBe(1);
    expect(await Bun.file(join(s.cwd, "approved-marker.txt")).exists()).toBe(true);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});

for (const mode of ["deny", "invalid", "no approver", "read only", "interrupt"] as const) test(`native command approval fails closed: ${mode}`, async () => {
  let asked = 0;
  const s = makeStubSession(() => { throw new Error("native only"); }, {
    resolveModel: () => req("claude-cli").model,
    createAdapter: () => adapter({ FAKE_NATIVE_PERMISSION: "1" }), streamWithRetry,
    autoRejectPermissionRequests: mode === "no approver",
  }, { async requestPermission() {
    asked++;
    if (mode === "interrupt") { setTimeout(() => s.session.interrupt(true), 0); return new Promise(() => {}); }
    return { selectedOption: mode === "invalid" ? "proceed_always" : "cancel" };
  } });
  try {
    if (mode === "read only") s.session.updateSettings({ autonomyLevel: "off" });
    s.session.addUserMessage("Run the workspace tests"); await s.session.settled();
    expect(asked).toBe(mode === "read only" || mode === "no approver" ? 0 : 1);
    expect(await Bun.file(join(s.cwd, "approved-marker.txt")).exists()).toBe(false);
    expect(s.session.pendingPrompts()).toHaveLength(0);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});

for (const backend of ["claude-cli", "codex-cli"] as const) test(`${backend} completes through native events without replaying tools`, async () => {
  const events = await collect(adapter({ ANTHROPIC_API_KEY: "unused", OPENAI_API_KEY: "unused" }).stream(req(backend)));
  expect(events.some((e) => e.type === "tool_use_start")).toBe(false);
  expect(done(events).stopReason).toBe("end_turn");
  expect(done(events).usage.cacheReadTokens).toBe(5);
  expect(done(events).content[0]).toMatchObject({ type: "text" });
});

for (const backend of ["claude-cli", "codex-cli"] as const) test(`${backend} synthesis retains only the answer text for structured judges and summaries`, async () => {
  const r = req(backend); r.nativeExecution = { ...r.nativeExecution!, readOnly: true, synthesis: true };
  const events = await collect(adapter().stream(r)); expect(done(events).content).toEqual([{ type: "text", text: "done" }]);
});

for (const backend of ["claude-cli", "codex-cli"] as const) for (const failed of [false, true]) test(`${backend} records structured native tool outcomes on ${failed ? "failed" : "completed"} turns without duplicate bridge accounting`, async () => {
  const metrics: any[] = [];
  const fixture = makeStubSession(() => { throw new Error("must use native client"); }, {
    resolveModel: () => req(backend).model, createAdapter: () => adapter({ FAKE_METRICS: "1", ...(failed ? { FAKE_METRICS_FAIL: "1" } : {}) }), streamWithRetry,
    persistence: { appendMessage: async () => {}, appendTurnOutcome: async () => {}, saveSettings: async () => {}, appendAnalyticsMetric: async (metric) => { metrics.push(metric); } },
  });
  try {
    fixture.session.addUserMessage("Inspect the fixture"); await fixture.session.settled();
    const tools = metrics.filter((m) => m.kind === "tool"); expect(new Set(tools.map((m) => m.id)).size).toBe(3);
    expect(tools.every((m) => m.model === req(backend).model.id)).toBe(true);
    expect(tools.filter((m) => m.status === "failure").length).toBe(1); expect(tools.filter((m) => m.status === "success").length).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain("PRIVATE_"); expect(JSON.stringify(tools)).not.toContain("bridge");
    expect(metrics.filter((m) => m.kind === "usage").length).toBe(failed ? 0 : 1); expect(metrics.find((m) => m.kind === "turn")?.reason).toBe(failed ? "model_request_rejected" : "completed");
  } finally { await fixture.session.end(); rmSync(fixture.cwd, { recursive: true, force: true }); }
});

for (const backend of ["claude-cli", "codex-cli"] as const) test(`${backend} MCP calls use Rigwell Session gates and recorded tool results`, async () => {
  let called = 0;
  const s = makeStubSession(() => { throw new Error("must use native client"); }, {
    resolveModel: () => req(backend).model, createAdapter: () => adapter({ FAKE_BRIDGE: "1" }), streamWithRetry,
    toolsFor: () => [{ name: "ListAgents", description: "fixture", inputSchema: { type: "object" }, category: "other", async run(_input, ctx) { called++; expect(ctx.sessionId).toBe(s.session.id); return { content: "fixture-roster" }; } }],
    decide: () => ({ decision: "allow" }),
  });
  try {
    s.session.addUserMessage("Read the Workstream roster"); await s.session.settled();
    expect(called).toBe(1);
    expect(s.notes.some((n) => n.type === "tool_result" && n.content === "fixture-roster")).toBe(true);
    const use = s.stored.flatMap((m) => m.content).find((b) => b.type === "tool_use");
    expect(use?.type === "tool_use" && use.name).toBe("ListAgents");
    expect(use?.type === "tool_use" && use.scriptExecution).toBeUndefined();
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});

test("native coordination cannot bypass the owning Session's permission refusal", async () => {
  let called = false;
  const s = makeStubSession(() => { throw new Error("must use native client"); }, {
    resolveModel: () => req("codex-cli").model, createAdapter: () => adapter({ FAKE_BRIDGE: "1", FAKE_EXPECT_DENIED: "1" }), streamWithRetry,
    toolsFor: () => [{ name: "ListAgents", description: "fixture", inputSchema: { type: "object" }, category: "other", async run() { called = true; return { content: "fixture-roster" }; } }],
    decide: () => ({ decision: "block", message: "Fixture policy refuses this tool" }),
  });
  try {
    s.session.addUserMessage("Read the roster"); await s.session.settled();
    expect(called).toBe(false);
    expect(s.notes.some((n) => n.type === "tool_result" && n.isError && n.content.includes("Fixture policy"))).toBe(true);
    expect(s.notes.some((n) => n.type === "agent_turn_completed" && n.reason === "completed")).toBe(true);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});

test("native member questions reach the user through Rigwell AskUser", async () => {
  let asked = 0;
  const s = makeStubSession(() => { throw new Error("must use native client"); }, {
    resolveModel: () => req("codex-cli").model, createAdapter: () => adapter({ FAKE_BRIDGE: "1", FAKE_ASK: "1" }), streamWithRetry,
    autoRejectPermissionRequests: false,
  }, { async requestAskUser(params) {
    asked++; expect(params.questions).toMatchObject([{ topic: "Fixture", question: "Which fixture?" }]);
    return { answers: [{ index: 0, question: "Which fixture?", answer: "fixture-roster" }] };
  } });
  try {
    s.session.addUserMessage("Ask the user which fixture"); await s.session.settled();
    expect(asked).toBe(1);
    expect(s.notes.some((n) => n.type === "tool_result" && n.content.includes("fixture-roster"))).toBe(true);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});
for (const backend of ["claude-cli", "codex-cli"] as const) test(`${backend} service installation and browser evaluation retain actual Session approval gates`, async () => {
  const env = tmpEnv(), svc = createAutomationService({ runner: async () => ({ ok: true, text: "unused" }) });
  try {
    for (const approve of [false, true]) {
      let approvals = 0;
      const s = makeStubSession(() => { throw new Error("native client only"); }, {
        resolveModel: () => req(backend).model,
        createAdapter: () => adapter({ FAKE_BRIDGE: "1", FAKE_TOOL: "InstallLocalService", FAKE_INPUT: JSON.stringify({ service: "triage", repo: "fixture/project", workingDirectory: env.root, postResult: true }), ...(approve ? { FAKE_EXPECT_TEXT: "Local triage" } : { FAKE_EXPECT_DENIED: "1" }) }), streamWithRetry,
        toolsFor: () => automationTools(svc), autoRejectPermissionRequests: !approve,
      }, { async requestPermission(params) { approvals++; expect(JSON.stringify(params)).toContain('"postResult":true'); return { selectedOption: "proceed_once" }; } });
      try { s.session.addUserMessage("Install local triage"); await s.session.settled(); expect(approvals).toBe(approve ? 1 : 0); expect(svc.manager.list()).toHaveLength(approve ? 1 : 0); expect(s.notes.some((n) => n.type === "error")).toBe(false); }
      finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
    }
    let evaluated = false;
    const s = makeStubSession(() => { throw new Error("native client only"); }, {
      resolveModel: () => req(backend).model, createAdapter: () => adapter({ FAKE_BRIDGE: "1", FAKE_TOOL: "browser_evaluate", FAKE_INPUT: '{"expression":"document.title"}', FAKE_EXPECT_DENIED: "1" }), streamWithRetry,
      toolsFor: () => [{ name: "browser_evaluate", description: "evaluate", inputSchema: { type: "object" }, category: "other", async run() { evaluated = true; return { content: "unused" }; } }],
    });
    try { s.session.addUserMessage("Evaluate page"); await s.session.settled(); expect(evaluated).toBe(false); expect(s.notes.some((n) => n.type === "tool_result" && n.isError)).toBe(true); expect(s.notes.some((n) => n.type === "error")).toBe(false); }
    finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
  } finally { svc.stop(); await svc.manager.idle(); env.cleanup(); }
});

test("native auth rejects API-key login before execution", async () => {
  const error = await collect(adapter({ FAKE_API: "1" }).stream(req("claude-cli"))).catch((e) => e);
  expect(error.kind).toBe("auth");
});
test("malformed and failed events are terminal and never retried", async () => {
  for (const env of [{ FAKE_BAD: "1" }, { FAKE_FAIL: "1" }]) {
    const error = await collect(streamWithRetry(adapter(env), req("codex-cli"))).catch((e) => e);
    expect(error.retryable).toBe(false);
  }
});
test("closing the stream cancels and awaits the owned client", async () => {
  const stream = adapter({ FAKE_WAIT: "1" }).stream(req("codex-cli"));
  expect((await stream.next()).value?.type).toBe("text_delta");
  const start = Date.now(); await stream.return(undefined);
  expect(Date.now() - start).toBeLessThan(5000);
});
test("read-only overrides unsafe flags and environment routes are removed case-insensitively", () => {
  const r = req("claude-cli"); r.nativeExecution = { cwd: dir, readOnly: true, skipPermissions: true };
  expect(nativeArguments(r)).toContain("plan");
  expect(nativeArguments(r)).not.toContain("--dangerously-skip-permissions");
  const env = nativeEnvironment({ anthropic_api_key: "secret", OPENAI_BASE_URL: "unused", HOME: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir, CODEX_WINDOWS_REGISTERED_CORE: "parent-only", CODEX_APP_TOOLS_PIPE_PATH: "parent-only" });
  expect(env.anthropic_api_key).toBeUndefined(); expect(env.OPENAI_BASE_URL).toBeUndefined();
  expect(env.HOME).toBe(dir); expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
  expect(env.CODEX_HOME).toBe(dir); expect(env.CODEX_WINDOWS_REGISTERED_CORE).toBeUndefined(); expect(env.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined();
});
test("profiles reject credential mixing and prompt keeps historical actions out of the current request", () => {
  const valid = { model: "test-model", provider: "anthropic", executionBackend: "claude-cli" as const };
  expect(validateCustomModels({ customModels: [valid] }).models[0]?.executionBackend).toBe("claude-cli");
  expect(validateCustomModels({ customModels: [{ ...valid, apiKey: "secret" }] }).problems.length).toBe(1);
  expect(validateCustomModels({ customModels: [{ ...valid, provider: "openai" }] }).problems.length).toBe(1);
  const r = req("claude-cli"); r.messages.unshift(userMsg("Earlier completed task", "old"));
  expect(nativePrompt(r)).toContain("Current user request:\nRead and fix");
});
test("Rigwell Session retains the turn lifecycle and stored answer", async () => {
  const m = req("claude-cli").model;
  const s = makeStubSession(() => { throw new Error("HTTP stub must not run"); }, {
    resolveModel: () => m, createAdapter: () => adapter(), streamWithRetry,
  });
  try {
    s.session.addUserMessage("Read the file");
    await s.session.settled();
    expect(s.stored.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.includes("done")))).toBe(true);
    expect(s.notes.some((n) => n.type === "agent_turn_completed")).toBe(true);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});
test("a required Rigwell commit scan fails closed before any native client launch", async () => {
  let launched = false;
  const s = makeStubSession(() => { throw new Error("must not run"); }, {
    resolveModel: () => req("claude-cli").model, enableSecretScan: true,
    createAdapter: () => { launched = true; return adapter(); }, streamWithRetry,
  });
  try {
    s.session.addUserMessage("Change and commit the file"); await s.session.settled();
    expect(launched).toBe(false);
    expect(s.notes.some((n) => JSON.stringify(n).includes("cannot enforce"))).toBe(true);
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});

test("later native invocations receive completed coordination results", async () => {
  const prompts: string[] = [];
  const client = adapter({ FAKE_BRIDGE: "1" });
  const s = makeStubSession(() => { throw new Error("native only"); }, {
    resolveModel: () => req("codex-cli").model, streamWithRetry,
    createAdapter: () => ({ async *stream(r: any) { prompts.push(nativePrompt(r)); yield* client.stream(r); } }),
    toolsFor: () => [{ name: "ListAgents", description: "fixture", inputSchema: { type: "object" }, category: "other", async run() { return { content: "existing-agent-and-listener-receipt" }; } }],
    decide: () => ({ decision: "allow" }),
  });
  try {
    s.session.addUserMessage("Read the roster"); await s.session.settled();
    s.session.addUserMessage("Continue the existing work"); await s.session.settled();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("existing-agent-and-listener-receipt");
    expect(prompts[1]).toContain("Current user request:\nContinue the existing work");
  } finally { await s.session.end(); rmSync(s.cwd, { recursive: true, force: true }); }
});
