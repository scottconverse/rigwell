// Shared helpers for end-to-end tests: temp repo, temp RIGWELL_HOME, and a JSON-RPC client over a child process.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { FakeTurn } from "../fakes/types.ts";

export const CLI = join(import.meta.dir, "../../src/cli/main.ts");

/** A small repo with one bug: greet() misspells "Hello". `node check.js` exits 0 once fixed. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rigwell-e2e-repo-"));
  writeFileSync(join(dir, "greet.js"), 'export function greet(name) {\n  return "Helo, " + name + "!";\n}\n');
  writeFileSync(join(dir, "check.js"),
    'import { greet } from "./greet.js";\nconst got = greet("Ada");\nif (got !== "Hello, Ada!") { console.error("FAIL: " + got); process.exit(1); }\nconsole.log("PASS");\n');
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

export function makeHome(models: { provider: "anthropic" | "openai" | "generic-chat-completion-api" | "google" | "bedrock-converse"; url: string; displayName: string; extra?: Record<string, unknown> }[]): string {
  const home = mkdtempSync(join(tmpdir(), "rigwell-e2e-home-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    customModels: models.map((m) => ({ model: `fake-${m.provider}`, displayName: m.displayName, provider: m.provider, baseUrl: m.url, apiKey: "test-key-not-real", ...(m.extra ?? {}) })),
  }, null, 2));
  return home;
}

/** Text of the last tool result the model was sent, for either provider's request body. */
export function lastToolResult(body: any): string {
  // Gemini: contents[].parts[].functionResponse
  if (Array.isArray(body.contents)) {
    const parts = (body.contents.at(-1)?.parts ?? []).filter((p: any) => p.functionResponse);
    return parts.map((p: any) => p.functionResponse.response?.output ?? p.functionResponse.response?.error ?? "").join("\n");
  }
  // Bedrock Converse: messages[].content[].toolResult
  if (Array.isArray(body.messages) && body.messages.at(-1)?.content?.some?.((b: any) => b.toolResult)) {
    return body.messages.at(-1).content.filter((b: any) => b.toolResult).map((b: any) => b.toolResult.content.map((c: any) => c.text ?? "").join("")).join("\n");
  }
  if (Array.isArray(body.messages) && body.messages.at(-1)?.role === "tool") {
    const outs = body.messages.filter((m: any, i: number, a: any[]) => m.role === "tool" && a.slice(i + 1).every((x: any) => x.role === "tool"));
    return outs.map((m: any) => m.content).join("\n");
  }
  if (Array.isArray(body.messages)) {
    const last = body.messages.at(-1);
    const r = (last?.content ?? []).filter((b: any) => b.type === "tool_result").at(-1);
    return typeof r?.content === "string" ? r.content : JSON.stringify(r?.content ?? "");
  }
  const outs = (body.input ?? []).filter((i: any) => i.type === "function_call_output");
  return outs.at(-1)?.output ?? "";
}

/** The fix-the-bug script, provider-neutral. Each step checks the previous tool result. */
export function fixBugScript(): FakeTurn[] {
  return [
    () => ({ text: "I'll look at the code.", toolCalls: [{ name: "Read", input: { path: "greet.js" } }] }),
    (body) => {
      if (!lastToolResult(body).includes('"Helo, "')) throw new Error("model was not sent the file contents");
      return { toolCalls: [{ name: "Edit", input: { path: "greet.js", old_text: '"Helo, "', new_text: '"Hello, "' } }] };
    },
    (body) => {
      if (!/replacements/.test(lastToolResult(body))) throw new Error("edit result missing");
      return { toolCalls: [{ name: "Execute", input: { command: "node check.js", riskLevel: "low", riskReason: "Runs the check script; changes nothing." } }] };
    },
    (body) => {
      if (!lastToolResult(body).includes("PASS")) throw new Error("check did not pass: " + lastToolResult(body));
      return { text: "Fixed the typo in greet.js; node check.js passes." };
    },
  ];
}

export class RpcChild {
  proc: ReturnType<typeof Bun.spawn>;
  messages: any[] = [];
  private buf = "";
  private n = 0;
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  /** Answers harness → client requests (request_permission). */
  onRequest?: (m: any) => any;
  stderr = "";

  constructor(args: string[], opts: { cwd: string; env: Record<string, string> }) {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.proc = proc;
    void this.pump();
    void (async () => { this.stderr = await new Response(proc.stderr as ReadableStream).text(); })();
  }

  private async pump() {
    const dec = new TextDecoder();
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      this.buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        this.messages.push(m);
        if (m.type === "request" && this.onRequest) {
          this.send({ jsonrpc: "2.0", type: "response", id: m.id, result: this.onRequest(m) });
        }
        this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
      }
    }
  }

  send(m: any) { (this.proc.stdin as any).write(JSON.stringify(m) + "\n"); }

  waitFor(pred: (m: any) => boolean, timeoutMs = 20000): Promise<any> {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting; stderr:\n" + this.stderr)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  async call(method: string, params: Record<string, unknown>): Promise<any> {
    const id = `t-${++this.n}`;
    this.send({ jsonrpc: "2.0", type: "request", id, method: `rigwell.${method}`, params });
    const r = await this.waitFor((m) => m.type === "response" && m.id === id);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }

  notifications(): any[] {
    return this.messages.filter((m) => m.method === "rigwell.session_notification").map((m) => m.params.notification);
  }

  turnCompleted() { return this.waitFor((m) => m.params?.notification?.type === "agent_turn_completed"); }

  async close() {
    (this.proc.stdin as any).end();
    return await this.proc.exited;
  }
}
