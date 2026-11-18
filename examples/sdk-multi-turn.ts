// Multi-turn session with the Rigwell SDK.
//
//   bun examples/sdk-multi-turn.ts [--model custom:My-Model-0] [--daemon-url ws://127.0.0.1:47822/]
//
// The model must be configured in ~/.rigwell/settings.json (customModels). With --daemon-url the session runs
// inside a running `rigwell daemon` (the token is read from $RIGWELL_HOME/daemon.json); otherwise the SDK
// spawns `rigwell exec --input-format stream-jsonrpc --output-format stream-jsonrpc` itself.
import { connectToDaemon, createSession, type RigwellSession } from "../src/sdk/index.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

// A custom MCP server attached to the session (initialize_session mcpServers). Its tools are deferred: the model
// loads them with load_tools and calls them with call_tool, or inside a Script as tools.my_tools.<name>(...).
// Replace the command with your own server; this one is the fake used by the tests.
const mcpServers = [{ name: "my-tools", command: "bun", args: [new URL("../test/fakes/fake-mcp-server.ts", import.meta.url).pathname] }];

const common = {
  cwd: process.cwd(),
  modelId: arg("--model"),
  autonomyLevel: "off" as const,
  // Without a permission handler, the SDK cancels individual permission requests.
  initParams: { mcpServers },
  // ask_user and pick_options default to "cancelled" unless you pass onAskUser / onPickOptions.
};

const url = arg("--daemon-url");
const session: RigwellSession = url ? await connectToDaemon({ ...common, url }) : await createSession(common);
console.log(`session ${session.sessionId} on ${session.settings.modelId}`);

async function turn(prompt: string) {
  console.log(`\n> ${prompt}`);
  for await (const n of session.send(prompt)) {
    if (n.type === "assistant_text_delta") process.stdout.write(n.textDelta);
    else if (n.type === "tool_call" && Object.keys(n.toolUse.input ?? {}).length) console.log(`\n[tool] ${n.toolUse.name}`);
    else if (n.type === "agent_turn_completed") console.log(`\n[turn ${n.reason}]`);
  }
}

await turn("Read the project documentation and summarise what the project is. Do not edit or run commands.");
await turn("Which of those files would you read first, and why?");
await turn("Load the my-tools__echo tool and call it with the text \"hello\", then tell me what it returned.");

console.log("\ncontext:", await session.getContextStats());
await session.close();
