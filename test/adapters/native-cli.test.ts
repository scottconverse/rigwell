import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCliAdapter, nativeEnvironment, nativeArguments, nativePrompt } from "../../src/adapters/native-cli.ts";
import { validateCustomModels } from "../../src/storage/models.ts";
import { model, request, userMsg, collect, done } from "./helpers.ts";
import { makeStubSession } from "../agent/helpers.ts";
import { streamWithRetry } from "../../src/adapters/retry.ts";

const dir = mkdtempSync(join(tmpdir(), "rigwell-native-"));
const fixture = join(dir, "client.js");
writeFileSync(fixture, `
const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_API?'api_key':'claude.ai',subscriptionType:'max'}));process.exit(0)}
if(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
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
 const tool=process.env.FAKE_ASK?'AskUser':'ListAgents';
 const listed=await call('tools/list');if(!listed.result.tools.some(t=>t.name===tool))process.exit(12);
 if(args[0]==='exec'&&!args.includes('mcp_servers.rigwell.tools.'+tool+'.approval_mode="approve"'))process.exit(14);
 const result=await call('tools/call',{name:tool,arguments:process.env.FAKE_ASK?{questions:[{topic:'Fixture',question:'Which fixture?',options:['one','two']}]}:{}});
 if(process.env.FAKE_EXPECT_DENIED){if(!result.result.isError)process.exit(15)}
 else if(!result.result.content[0].text.includes('fixture-roster'))process.exit(13);
}
if(process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY)process.exit(9);
if(process.env.FAKE_BAD){console.log('not-json');process.exit(0)}
if(process.env.FAKE_FAIL){console.log(JSON.stringify({type:'turn.failed',error:{message:'failed'}}));process.exit(0)}
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

for (const backend of ["claude-cli", "codex-cli"] as const) test(`${backend} completes through native events without replaying tools`, async () => {
  const events = await collect(adapter({ ANTHROPIC_API_KEY: "unused", OPENAI_API_KEY: "unused" }).stream(req(backend)));
  expect(events.some((e) => e.type === "tool_use_start")).toBe(false);
  expect(done(events).stopReason).toBe("end_turn");
  expect(done(events).usage.cacheReadTokens).toBe(5);
  expect(done(events).content[0]).toMatchObject({ type: "text" });
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
