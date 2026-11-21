// A short, plain name for what an agent does now, read from its session notifications.
const STATES: Record<string, string> = {
  idle: "",
  thinking: "Thinking",
  streaming_assistant_message: "Writing a reply",
  waiting_for_tool_confirmation: "Waiting for you",
  compacting_conversation: "Compacting the conversation",
};

/** The new step, "" when the agent stopped, or undefined when this notification does not change the step. */
export function stepFrom(n: Record<string, unknown>): string | undefined {
  if (n.type === "agent_working_state_changed") return STATES[String(n.newState)];
  if (n.type === "tool_call") {
    const name = (n.toolUse as { name?: unknown } | undefined)?.name;
    return typeof name === "string" && name ? `Running ${name}` : undefined;
  }
  return undefined;
}
