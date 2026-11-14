export interface TriggerEvent {
  id: string; kind: string; at: number; payload: unknown;
  reply?: { service: "github"; repo: string; issue: number } | { service: "slack"; channel: string; thread: string };
  chain?: string[];
}
