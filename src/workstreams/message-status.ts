import type { WorkstreamMessage } from "./store.ts";

export function workstreamMessageStatus(message: WorkstreamMessage): string {
  if (message.priority === "next" && message.to !== "user") {
    if (message.nativeSubmittedAt) return "Submitted to native client";
    return message.readAt ? "In session transcript" : "Queued";
  }
  return message.readAt ? "Read" : message.deliveredAt ? "Delivered" : "Queued";
}
