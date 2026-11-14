// Standalone scripted reference CLI for head-to-head acceptance. Never contacts a provider.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("reference-fixture 1"); process.exit(0); }
const args = process.argv.slice(2), cwd = args[args.indexOf("--cwd") + 1]!;
if (process.env.FAKE_COMPARISON_SETTINGS && args[args.indexOf("--settings") + 1] !== process.env.FAKE_COMPARISON_SETTINGS) throw new Error("Missing external runtime settings path");
if (!args.includes("exec") || args[args.indexOf("-m") + 1] !== "external-fixture") throw new Error("Incorrect mapped CLI arguments");
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.apiVersion !== "fixture-v1" || !m.method?.startsWith("reference.")) throw new Error("Missing configured protocol fields");
    const method = m.method.slice("reference.".length);
    if (method === "initialize_session") {
      if (m.params.modelId !== "external-fixture") throw new Error("Incorrect initialize model mapping");
      if (m.params.autonomyLevel !== "low" || m.params.reasoningEffort !== "low") throw new Error("Missing explicit wire autonomy/effort");
      if (process.env.FAKE_COMPARISON_AUDIT) appendFileSync(process.env.FAKE_COMPARISON_AUDIT, JSON.stringify({ cwd, model: m.params.modelId, autonomy: args[args.indexOf("--auto") + 1] }) + "\n");
      send({ type: "response", id: m.id, result: { sessionId: "reference-session" } });
    } else if (method === "add_user_message") {
      const file = join(cwd, "greet.js"), text = readFileSync(file, "utf8");
      if (!text.includes("Helo, ")) throw new Error("Trial did not start from a fresh fixture");
      writeFileSync(file, text.replace("Helo, ", "Hello, "));
      send({ type: "response", id: m.id, result: {} });
      send({ type: "notification", params: { notification: { type: "session_token_usage_changed", tokenUsage: { inputTokens: 100, cacheReadTokens: 25, outputTokens: 10 } } } });
      send({ type: "notification", params: { notification: { type: "agent_turn_completed", reason: "completed" } } });
    } else if (method === "close_session") { send({ type: "response", id: m.id, result: {} }); }
    else throw new Error("Unexpected reference method " + method);
  }
}
