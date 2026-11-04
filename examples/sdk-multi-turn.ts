// Multi-turn session with the Rigwell SDK.
//
//   bun examples/sdk-multi-turn.ts [--model custom:My-Model-0] [--daemon-url ws://127.0.0.1:47822/]
//
// The model must be configured in ~/.rigwell/settings.json (customModels). With --daemon-url the session runs
// inside a running `rigwell daemon` (the token is read from $RIGWELL_HOME/daemon.json); otherwise the SDK
// spawns `rigwell exec --input-format stream-jsonrpc --output-format stream-jsonrpc` itself.
import { connectToDaemon, createSession, type PermissionRequest, type RigwellSession } from "../src/sdk/index.ts";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

// Called for every rigwell.request_permission the harness sends. Without this handler the SDK answers "cancel".
function onPermission(req: PermissionRequest) {
  const use = req.toolUses[0];
  console.log(`\n[permission] ${use.confirmationType}: ${use.details.fullCommand ?? use.details.filePath ?? use.toolUse.name}`);
  // Allow once. Offered values: proceed_once, proceed_always, cancel.
  return { selectedOption: req.options.some((o) => o.value === "proceed_once") ? "proceed_once" : "cancel" };
}

// A custom MCP server attached to the session (initialize_session mcpServers). Its tools are deferred: the model
// loads them with load_tools and calls them with call_tool, or inside a Script as tools.my_tools.<name>(...).
// Replace the command with your own server; this one is the fake used by the tests.
const mcpServers = [{ name: "my-tools", command: "bun", args: [new URL("../test/fakes/fake-mcp-server.ts", import.meta.url).pathname] }];

const common = {
  cwd: process.cwd(),
  modelId: arg("--model"),
  autonomyLevel: "low" as const,
  onPermission,
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

await turn("List the files in this folder using a command, then summarise what the project is.");
await turn("Which of those files would you read first, and why?");
await turn("Load the my-tools__echo tool and call it with the text \"hello\", then tell me what it returned.");

console.log("\ncontext:", await session.getContextStats());
await session.close();
