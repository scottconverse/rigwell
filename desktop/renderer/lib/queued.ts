// The list of messages that wait for the agent. The service owns the order; this view keeps a just-sent message visible.
import type { Item } from "./transcript.ts";

export interface QueuedMessage { messageId: string; text: string }
export type QueuePlacement = "end_of_turn" | "end_of_loop";

/** Merges the service list with messages the service has not acknowledged. A message already in the transcript never waits. */
export function mergeQueued(
  items: Item[],
  server: readonly { messageId: string; text: string }[],
  unacknowledged: ReadonlyMap<string, string>,
  shown: ReadonlyMap<string, string>,
): QueuedMessage[] {
  const inTranscript = (id: string) => items.some((item) => item.id === `${id}:0`);
  const list = server
    .filter((m) => !inTranscript(m.messageId))
    .map((m) => ({ messageId: m.messageId, text: shown.get(m.messageId) ?? m.text }));
  for (const [messageId, text] of unacknowledged) {
    if (!inTranscript(messageId) && !list.some((m) => m.messageId === messageId)) list.push({ messageId, text });
  }
  return list;
}
